import "fake-indexeddb/auto";
import { expect, it } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  BalanceId,
  PaymentLinkReceipt,
  PaymentLinkRecipient,
  PositiveAmount,
  TransferId,
  TransferOrder,
  Username,
  baseAsset,
} from "../src/contract";
import type { AssertionCeremony } from "../src/device/assertion";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  PublicDeviceWallet,
  SealedDeviceWallet,
  clearStoredLink,
} from "../src/device/key-store";
import {
  reopenLocalEnvelope,
  sealLocalEnvelope,
} from "../src/device/local-envelope";
import { network } from "../src/stellar/network";
import { addressOf } from "./device-fixtures";
import {
  type RawStoredEntry,
  clearDatabase,
  enrollDisposableWallet,
  putRawEntry,
  relyingParty,
  storedEntry,
  storedKeys,
} from "./sealed-wallet-fixtures";
import { assertTagged } from "./tagged";

const normalizeBytes = (bytes: Uint8Array) =>
  `${Buffer.from(bytes).toString("base64")}:${Buffer.from(bytes).toString("hex")}`;

const unwrapValue = <A>(value: A): Schema.Json => {
  if (Redacted.isRedacted(value)) return unwrapValue(Redacted.value(value));

  if (value instanceof Uint8Array) return normalizeBytes(value);

  if (value instanceof ArrayBuffer)
    return normalizeBytes(new Uint8Array(value));

  if (ArrayBuffer.isView(value))
    return normalizeBytes(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );

  if (Array.isArray(value)) return value.map((item) => unwrapValue(item));

  if (Predicate.isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, unwrapValue(entry)]),
    );

  if (Predicate.isString(value)) return value;

  if (Predicate.isNumber(value)) return value;

  if (Predicate.isBoolean(value)) return value;

  if (value === null) return null;

  return String(value);
};

const serializeForLeakCheck = <A>(value: A) =>
  JSON.stringify(unwrapValue(value));

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
            requestPayloads.push(serializeForLeakCheck(request));
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
      const serializedRecord = serializeForLeakCheck(rawRecord);
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
    }),
);

const unknownFormats = [
  [
    "a v1 wallet record with a colocated wrapping key",
    (encoded: typeof SealedDeviceWallet.Encoded): RawStoredEntry => ({
      address: encoded.public.address,
      username: encoded.public.username,
      iv: Buffer.alloc(12, 1).toString("base64"),
      phrase: Buffer.alloc(32, 2).toString("base64"),
    }),
  ],
  [
    "an unknown envelope version",
    (encoded: typeof SealedDeviceWallet.Encoded): RawStoredEntry => ({
      ...encoded,
      version: 99,
    }),
  ],
] as const;

it.effect.each(unknownFormats)(
  "treats %s as empty without upgrading it",
  ([, buildLegacyRecord]) =>
    Effect.gen(function* () {
      yield* Effect.promise(clearDatabase);

      const disposable = yield* enrollDisposableWallet();
      const encoded = Schema.encodeSync(SealedDeviceWallet)(disposable.record);
      const raw = buildLegacyRecord(encoded);

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

const damagedV2Records = [
  [
    "malformed ciphertext base64",
    (encoded: typeof SealedDeviceWallet.Encoded): RawStoredEntry => ({
      ...encoded,
      envelope: {
        ...encoded.envelope,
        ciphertext: "not-valid-base64!!!",
      },
    }),
  ],
  [
    "a damaged pinned credential",
    (encoded: typeof SealedDeviceWallet.Encoded): RawStoredEntry => ({
      ...encoded,
      credential: {
        ...encoded.credential,
        algorithm: "HS256",
      },
    }),
  ],
] as const;

it.effect.each(damagedV2Records)(
  "fails with CorruptDeviceWallet when a v2 record has %s",
  ([, damage]) =>
    Effect.gen(function* () {
      yield* Effect.promise(clearDatabase);

      const disposable = yield* enrollDisposableWallet();
      const encoded = Schema.encodeSync(SealedDeviceWallet)(disposable.record);
      const raw = damage(encoded);

      yield* Effect.promise(() => putRawEntry("wallet", raw));

      const publicFailure = yield* browserKeyStore
        .readPublic()
        .pipe(Effect.flip);

      const sealedFailure = yield* browserKeyStore
        .readSealed()
        .pipe(Effect.flip);

      const updateFailure = yield* browserKeyStore
        .updatePublic((current) => Option.some(current))
        .pipe(Effect.flip);

      expect(publicFailure._tag).toBe("CorruptDeviceWallet");
      expect(sealedFailure._tag).toBe("CorruptDeviceWallet");
      expect(updateFailure._tag).toBe("CorruptDeviceWallet");
      expect(yield* Effect.promise(() => storedEntry("wallet"))).toEqual(raw);
    }),
);
