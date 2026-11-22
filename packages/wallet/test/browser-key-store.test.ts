import "fake-indexeddb/auto";
import { expect, it } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  BalanceId,
  PasskeyChallenge,
  PaymentLinkReceipt,
  PaymentLinkRecipient,
  PositiveAmount,
  TransferId,
  TransferOrder,
  Username,
  baseAsset,
} from "../src/contract";
import {
  type AssertionCeremony,
  PinnedCredential,
} from "../src/device/assertion";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  PublicDeviceWallet,
  SealedDeviceWallet,
  clearStoredLink,
} from "../src/device/key-store";
import {
  LocalPhraseEnvelope,
  freshInstallationSalt,
  localEnvelopeVersion,
  localPhrasePrfInput,
  paymentLinkPrfInput,
  reopenLocalEnvelope,
  sealLocalEnvelope,
} from "../src/device/local-envelope";
import { backupSalt } from "../src/device/phrase-seal";
import { generateSecretPhrase } from "../src/device/secret-phrase";
import { signingKey } from "../src/device/signing";
import { network } from "../src/stellar/network";
import { addressOf } from "./device-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";

const relyingParty = { origin: "http://localhost:3000", rpId: "localhost" };
const dummyChallenge = Schema.decodeSync(PasskeyChallenge)("A".repeat(43));

const withEntryStore = <A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
) =>
  new Promise<A>((resolve, reject) => {
    const request = indexedDB.open("orchid-device", 1);

    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains("entries"))
        request.result.createObjectStore("entries");
    });
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("success", () => {
      const transaction = request.result.transaction("entries", mode);
      const op = run(transaction.objectStore("entries"));

      op.addEventListener("error", () => reject(op.error));
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("complete", () => {
        request.result.close();
        resolve(op.result);
      });
    });
  });

const clearDatabase = () =>
  withEntryStore("readwrite", (store) => store.clear());

const storedEntry = (name: string) =>
  withEntryStore("readonly", (store) => store.get(name));

const storedKeys = () =>
  withEntryStore("readonly", (store) => store.getAllKeys());

type RawStoredEntry =
  | {
      readonly address: string;
      readonly username: string;
      readonly iv: string;
      readonly phrase: string;
    }
  | {
      readonly version: number;
      readonly public: { readonly address: string; readonly username: string };
    }
  | typeof SealedDeviceWallet.Encoded
  | CryptoKey;

const putRawEntry = (name: string, value: RawStoredEntry) =>
  withEntryStore("readwrite", (store) => store.put(value, name));

const enrollDisposableWallet = (name = "maria") =>
  Effect.gen(function* () {
    const phrase = generateSecretPhrase();
    const key = signingKey(phrase);
    const address = addressOf(key);
    const username = Schema.decodeSync(Username)(name);
    const auth = new SoftwareAuthenticator(relyingParty.origin);
    const salt = freshInstallationSalt();
    const prfInput = yield* localPhrasePrfInput({ network, address, salt });

    const registered = Option.getOrThrow(
      yield* auth.passkeys.register(dummyChallenge, username, prfInput),
    );

    const credential = new PinnedCredential({
      id: registered.registration.id,
      publicKey: registered.registration.publicKey,
      algorithm: "ES256",
    });

    const prf = Redacted.make(Uint8Array.from(registered.prf));

    const sealed = yield* sealLocalEnvelope(
      {
        phrase,
        network,
        address,
        credentialId: credential.id,
        salt,
      },
      prf,
    );

    assertTagged(sealed, "EnvelopeSealed");

    const publicWallet = new PublicDeviceWallet({
      address,
      username,
      backup: "stored",
    });

    const record = new SealedDeviceWallet({
      version: localEnvelopeVersion,
      public: publicWallet,
      credential,
      envelope: sealed.envelope,
    });

    return {
      phrase,
      key,
      address,
      auth,
      salt,
      prf,
      credential,
      publicWallet,
      envelope: sealed.envelope,
      record,
    };
  });

const flipFirstByte = (bytes: Uint8Array) => {
  const copy = Uint8Array.from(bytes);

  copy[0] = (copy[0] ?? 0) ^ 0xff;

  return copy;
};

it.effect(
  "seals, persists without leaking secrets, updates public metadata atomically, and reopens with a fresh pinned assertion",
  () =>
    Effect.gen(function* () {
      yield* Effect.promise(clearDatabase);

      expect(yield* browserKeyStore.readPublic()).toEqual(Option.none());
      expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());

      const disposable = yield* enrollDisposableWallet();

      const secondSeal = yield* sealLocalEnvelope(
        {
          phrase: disposable.phrase,
          network,
          address: disposable.address,
          credentialId: disposable.credential.id,
          salt: disposable.salt,
        },
        disposable.prf,
      );

      assertTagged(secondSeal, "EnvelopeSealed");
      expect(secondSeal.envelope.iv).toHaveLength(12);
      expect(secondSeal.envelope.iv).not.toEqual(disposable.envelope.iv);
      expect(secondSeal.envelope.ciphertext).not.toEqual(
        disposable.envelope.ciphertext,
      );

      const requestPayloads: Array<string> = [];
      const logLines: Array<string> = [];

      const observingCeremony: AssertionCeremony = {
        assert: (request) =>
          Effect.sync(() => {
            requestPayloads.push(
              JSON.stringify({
                credentialId: request.credentialId,
                challenge: request.challenge,
                prf: Option.map(request.prf, (inputs) => ({
                  first: Buffer.from(inputs.first).toString("base64"),
                  second: Option.map(inputs.second, (second) =>
                    Buffer.from(second).toString("base64"),
                  ),
                })),
              }),
            );
          }).pipe(Effect.andThen(disposable.auth.assertions.assert(request))),
      };

      const captureLogger = Logger.make((options) => {
        logLines.push(String(options.message));
      });

      const candidateProof = yield* reopenLocalEnvelope(
        observingCeremony,
        relyingParty,
        disposable.credential,
        disposable.envelope,
        {
          network,
          address: disposable.address,
          purpose: "backup",
        },
      ).pipe(Effect.provide(Logger.layer([captureLogger])));

      assertTagged(candidateProof, "PhraseOpened");
      expect(Redacted.value(candidateProof.phrase)).toBe(disposable.phrase);

      const amount = Schema.decodeSync(PositiveAmount)("10000000");
      const linkA = addressOf(Keypair.random());
      const linkB = addressOf(Keypair.random());

      const balanceA = Schema.decodeSync(BalanceId)(
        `00000000${"a".repeat(64)}`,
      );

      const balanceB = Schema.decodeSync(BalanceId)(
        `00000000${"b".repeat(64)}`,
      );

      const orderA = new TransferOrder({
        id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
        from: disposable.address,
        to: PaymentLinkRecipient.make({ value: linkA }),
        asset: baseAsset,
        amount,
      });

      const orderB = new TransferOrder({
        id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
        from: disposable.address,
        to: PaymentLinkRecipient.make({ value: linkB }),
        asset: baseAsset,
        amount,
      });

      const receiptA = new PaymentLinkReceipt({
        network,
        address: linkA,
        asset: baseAsset,
        amount,
        balance: balanceA,
        attempts: [balanceA],
      });

      const receiptB = new PaymentLinkReceipt({
        network,
        address: linkB,
        asset: baseAsset,
        amount,
        balance: balanceB,
        attempts: [balanceB],
      });

      const withB = new SealedDeviceWallet({
        ...disposable.record,
        public: new PublicDeviceWallet({
          ...disposable.publicWallet,
          transfer: orderB,
          approvedUntil: 200,
          linkReceipt: receiptB,
        }),
      });

      yield* browserKeyStore.writeSealed(withB);

      const keys = yield* Effect.promise(storedKeys);
      const rawRecord = yield* Effect.promise(() => storedEntry("wallet"));
      const serializedRecord = JSON.stringify(rawRecord);
      const serializedRequests = requestPayloads.join("\n");
      const serializedLogs = logLines.join("\n");

      const prfBytes = Redacted.value(disposable.prf);

      const forbiddenSecrets = [
        disposable.phrase,
        Buffer.from(disposable.phrase).toString("base64"),
        disposable.key.secret(),
        Buffer.from(prfBytes).toString("base64"),
        Buffer.from(prfBytes).toString("hex"),
      ];

      expect(keys).toEqual(["wallet"]);

      for (const secret of forbiddenSecrets) {
        expect(serializedRecord).not.toContain(secret);
        expect(serializedRequests).not.toContain(secret);
        expect(serializedLogs).not.toContain(secret);
      }

      const beforeEnvelope = Option.getOrThrow(
        yield* browserKeyStore.readSealed(),
      ).envelope;

      const nextUsername = Schema.decodeSync(Username)("ana");
      const nextSponsor = addressOf(Keypair.random());

      const updated = yield* browserKeyStore.updatePublic((current) =>
        Option.some(
          new PublicDeviceWallet({
            ...current,
            username: nextUsername,
            reserveSponsor: nextSponsor,
          }),
        ),
      );

      const expectedWithB = new PublicDeviceWallet({
        ...withB.public,
        username: nextUsername,
        reserveSponsor: nextSponsor,
      });

      expect(updated).toEqual(
        Option.some({ wallet: expectedWithB, updated: true }),
      );

      yield* clearStoredLink(browserKeyStore, {
        address: disposable.address,
        transferId: orderA.id,
        approvedUntil: 100,
        receipt: receiptA,
      });

      expect(yield* browserKeyStore.readPublic()).toEqual(
        Option.some(expectedWithB),
      );

      yield* clearStoredLink(browserKeyStore, {
        address: disposable.address,
        transferId: orderB.id,
        approvedUntil: 200,
        receipt: receiptB,
      });

      const expectedCleared = new PublicDeviceWallet({
        ...disposable.publicWallet,
        username: nextUsername,
        reserveSponsor: nextSponsor,
        transferRevision: 1,
      });

      expect(yield* browserKeyStore.readPublic()).toEqual(
        Option.some(expectedCleared),
      );

      const persisted = Option.getOrThrow(yield* browserKeyStore.readSealed());

      expect(persisted.envelope).toEqual(beforeEnvelope);

      const reopened = yield* reopenLocalEnvelope(
        observingCeremony,
        relyingParty,
        persisted.credential,
        persisted.envelope,
        {
          network,
          address: persisted.public.address,
          purpose: "approval",
        },
      );

      assertTagged(reopened, "PhraseOpened");
      expect(Redacted.value(reopened.phrase)).toBe(disposable.phrase);
      expect(signingKey(Redacted.value(reopened.phrase)).publicKey()).toBe(
        persisted.public.address,
      );
    }),
);

const corruptEnvelopeCases = [
  [
    "an envelope swapped from another wallet",
    (
      primary: LocalPhraseEnvelope,
      other: LocalPhraseEnvelope,
    ): LocalPhraseEnvelope =>
      new LocalPhraseEnvelope({
        ...primary,
        salt: other.salt,
        iv: other.iv,
        ciphertext: other.ciphertext,
      }),
  ],
  [
    "a swapped wallet address in the envelope context",
    (
      primary: LocalPhraseEnvelope,
      other: LocalPhraseEnvelope,
    ): LocalPhraseEnvelope =>
      new LocalPhraseEnvelope({
        ...primary,
        address: other.address,
      }),
  ],
  [
    "a swapped network in the envelope context",
    (primary: LocalPhraseEnvelope): LocalPhraseEnvelope =>
      new LocalPhraseEnvelope({
        ...primary,
        network: "mainnet",
      }),
  ],
  [
    "a swapped credential ID in the envelope context",
    (
      primary: LocalPhraseEnvelope,
      other: LocalPhraseEnvelope,
    ): LocalPhraseEnvelope =>
      new LocalPhraseEnvelope({
        ...primary,
        credentialId: other.credentialId,
      }),
  ],
  [
    "a tampered installation salt",
    (primary: LocalPhraseEnvelope): LocalPhraseEnvelope =>
      new LocalPhraseEnvelope({
        ...primary,
        salt: flipFirstByte(primary.salt),
      }),
  ],
  [
    "a tampered IV",
    (primary: LocalPhraseEnvelope): LocalPhraseEnvelope =>
      new LocalPhraseEnvelope({
        ...primary,
        iv: flipFirstByte(primary.iv),
      }),
  ],
  [
    "a tampered ciphertext",
    (primary: LocalPhraseEnvelope): LocalPhraseEnvelope =>
      new LocalPhraseEnvelope({
        ...primary,
        ciphertext: flipFirstByte(primary.ciphertext),
      }),
  ],
] as const;

it.effect.each(corruptEnvelopeCases)(
  "rejects %s as CorruptEnvelope",
  ([, mutate]) =>
    Effect.gen(function* () {
      yield* Effect.promise(clearDatabase);

      const primary = yield* enrollDisposableWallet("maria");
      const other = yield* enrollDisposableWallet("pedro");

      const tampered = new SealedDeviceWallet({
        ...primary.record,
        envelope: mutate(primary.envelope, other.envelope),
      });

      yield* Effect.promise(() =>
        putRawEntry("wallet", Schema.encodeSync(SealedDeviceWallet)(tampered)),
      );

      const persisted = Option.getOrThrow(yield* browserKeyStore.readSealed());

      const outcome = yield* reopenLocalEnvelope(
        primary.auth.assertions,
        relyingParty,
        persisted.credential,
        persisted.envelope,
        {
          network,
          address: persisted.public.address,
          purpose: "approval",
        },
      );

      expect(outcome._tag).toBe("CorruptEnvelope");
    }),
);

it.effect(
  "refuses sealing a phrase for another address and distinguishes passkey failures from corrupt data",
  () =>
    Effect.gen(function* () {
      const primary = yield* enrollDisposableWallet("maria");
      const other = yield* enrollDisposableWallet("pedro");

      const mismatchedSeal = yield* sealLocalEnvelope(
        {
          phrase: other.phrase,
          network,
          address: primary.address,
          credentialId: primary.credential.id,
          salt: primary.salt,
        },
        primary.prf,
      );

      primary.auth.prf = false;

      const missingPrf = yield* reopenLocalEnvelope(
        primary.auth.assertions,
        relyingParty,
        primary.credential,
        primary.envelope,
        {
          network,
          address: primary.address,
          purpose: "approval",
        },
      );

      primary.auth.prf = true;
      primary.auth.cancels = true;

      const cancelled = yield* reopenLocalEnvelope(
        primary.auth.assertions,
        relyingParty,
        primary.credential,
        primary.envelope,
        {
          network,
          address: primary.address,
          purpose: "approval",
        },
      ).pipe(Effect.flip);

      expect(mismatchedSeal._tag).toBe("CorruptEnvelope");
      expect(missingPrf._tag).toBe("PrfOutputMissing");
      expect(cancelled._tag).toBe("PasskeyCancelled");
    }),
);

const unknownFormats = [
  [
    "a v1 wallet record with a colocated wrapping key",
    (address: string) => ({
      address,
      username: "maria",
      iv: Buffer.alloc(12, 1).toString("base64"),
      phrase: Buffer.alloc(32, 2).toString("base64"),
    }),
  ],
  [
    "an unknown envelope version",
    (address: string) => ({
      version: 99,
      public: { address, username: "maria" },
    }),
  ],
] as const;

it.effect.each(unknownFormats)(
  "treats %s as empty without upgrading it",
  ([, legacyRecord]) =>
    Effect.gen(function* () {
      yield* Effect.promise(clearDatabase);

      const disposable = yield* enrollDisposableWallet();
      const raw = legacyRecord(disposable.address);

      const legacyKey = yield* Effect.promise(() =>
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]),
      );

      yield* Effect.promise(() => putRawEntry("wallet", raw));
      yield* Effect.promise(() => putRawEntry("wrapping-key", legacyKey));

      expect(yield* browserKeyStore.readPublic()).toEqual(Option.none());
      expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());
      expect(
        yield* browserKeyStore.updatePublic((current) => Option.some(current)),
      ).toEqual(Option.none());
      expect(yield* Effect.promise(() => storedEntry("wallet"))).toEqual(raw);

      yield* browserKeyStore.writeSealed(disposable.record);

      expect(yield* Effect.promise(storedKeys)).toEqual(["wallet"]);
      expect(yield* browserKeyStore.readPublic()).toEqual(
        Option.some(disposable.publicWallet),
      );
    }),
);

it.effect(
  "keeps local phrase, server backup and each payment link on independent PRF inputs",
  () =>
    Effect.gen(function* () {
      const address = addressOf(Keypair.random());
      const otherAddress = addressOf(Keypair.random());
      const linkA = addressOf(Keypair.random());
      const linkB = addressOf(Keypair.random());
      const salt = freshInstallationSalt();
      const otherSalt = freshInstallationSalt();

      const inputs = [
        yield* backupSalt,
        yield* localPhrasePrfInput({ network, address, salt }),
        yield* localPhrasePrfInput({ network: "mainnet", address, salt }),
        yield* localPhrasePrfInput({ network, address: otherAddress, salt }),
        yield* localPhrasePrfInput({ network, address, salt: otherSalt }),
        yield* paymentLinkPrfInput({
          network,
          address,
          linkAddress: linkA,
          salt,
        }),
        yield* paymentLinkPrfInput({
          network,
          address,
          linkAddress: linkB,
          salt,
        }),
      ];

      const hexInputs = inputs.map((input) =>
        Buffer.from(input).toString("hex"),
      );

      expect(inputs.every((input) => input.byteLength === 32)).toBe(true);
      expect(new Set(hexInputs).size).toBe(inputs.length);
    }),
);
