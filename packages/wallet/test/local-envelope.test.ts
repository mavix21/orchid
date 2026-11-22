import "fake-indexeddb/auto";
import { expect, it } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { browserKeyStore } from "../src/device/browser-key-store";
import { SealedDeviceWallet } from "../src/device/key-store";
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
import type { SecretPhrase } from "../src/device/secret-phrase";
import { network } from "../src/stellar/network";
import { addressOf } from "./device-fixtures";
import {
  clearDatabase,
  enrollDisposableWallet,
  putRawEntry,
  relyingParty,
} from "./sealed-wallet-fixtures";
import { assertTagged } from "./tagged";

const encoder = new TextEncoder();

const canonicalTuple = (
  parts: ReadonlyArray<Uint8Array>,
): Uint8Array<ArrayBuffer> => {
  const totalLength = parts.reduce((sum, part) => sum + 4 + part.byteLength, 0);

  const buffer = new ArrayBuffer(totalLength);
  const output = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 0;

  for (const part of parts) {
    view.setUint32(offset, part.byteLength, false);
    offset += 4;
    output.set(part, offset);
    offset += part.byteLength;
  }

  return output;
};

const forgeAuthenticatedEnvelope = (
  target: {
    readonly address: SealedDeviceWallet["public"]["address"];
    readonly credentialId: SealedDeviceWallet["credential"]["id"];
    readonly salt: Uint8Array;
    readonly prf: Redacted.Redacted<Uint8Array<ArrayBuffer>>;
  },
  phrase: SecretPhrase,
) =>
  Effect.promise(async () => {
    const versionTag = encoder.encode(`v${localEnvelopeVersion}`);

    const hkdfKey = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(Redacted.value(target.prf)),
      "HKDF",
      false,
      ["deriveKey"],
    );

    const key = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: Uint8Array.from(target.salt),
        info: canonicalTuple([
          encoder.encode("orchid-device-phrase-key"),
          versionTag,
          encoder.encode(network),
          encoder.encode(target.address),
          encoder.encode(target.credentialId),
        ]),
      },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));

    const additionalData = canonicalTuple([
      encoder.encode("orchid-device-phrase-aad"),
      versionTag,
      encoder.encode(network),
      encoder.encode(target.address),
      encoder.encode(target.credentialId),
      target.salt,
    ]);

    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData },
        key,
        encoder.encode(phrase),
      ),
    );

    return new LocalPhraseEnvelope({
      version: localEnvelopeVersion,
      network,
      address: target.address,
      credentialId: target.credentialId,
      salt: Uint8Array.from(target.salt),
      iv,
      ciphertext,
    });
  });

const flipFirstByte = (bytes: Uint8Array) => {
  const copy = Uint8Array.from(bytes);

  copy[0] = (copy[0] ?? 0) ^ 0xff;

  return copy;
};

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
  "rejects an authenticated envelope whose decrypted phrase derives another address and distinguishes passkey failures",
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

      const forgedSamePhrase = yield* forgeAuthenticatedEnvelope(
        {
          address: primary.address,
          credentialId: primary.credential.id,
          salt: primary.salt,
          prf: primary.prf,
        },
        primary.phrase,
      );

      const forgedWrongPhrase = yield* forgeAuthenticatedEnvelope(
        {
          address: primary.address,
          credentialId: primary.credential.id,
          salt: primary.salt,
          prf: primary.prf,
        },
        other.phrase,
      );

      const validReopen = yield* reopenLocalEnvelope(
        primary.auth.assertions,
        relyingParty,
        primary.credential,
        forgedSamePhrase,
        {
          network,
          address: primary.address,
          purpose: "approval",
        },
      );

      const wrongDerivedAddress = yield* reopenLocalEnvelope(
        primary.auth.assertions,
        relyingParty,
        primary.credential,
        forgedWrongPhrase,
        {
          network,
          address: primary.address,
          purpose: "approval",
        },
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
      assertTagged(validReopen, "PhraseOpened");
      expect(wrongDerivedAddress._tag).toBe("CorruptEnvelope");
      expect(missingPrf._tag).toBe("PrfOutputMissing");
      expect(cancelled._tag).toBe("PasskeyCancelled");
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
