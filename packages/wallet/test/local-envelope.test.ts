import "fake-indexeddb/auto";
import { expect, it } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { browserKeyStore } from "../src/device/browser-key-store";
import { SealedDeviceWallet } from "../src/device/key-store";
import {
  LocalPhraseEnvelope,
  freshInstallationSalt,
  localPhrasePrfInput,
  paymentLinkPrfInput,
  reopenLocalEnvelope,
  sealLocalEnvelope,
} from "../src/device/local-envelope";
import { backupSalt } from "../src/device/phrase-seal";
import { network } from "../src/stellar/network";
import { addressOf } from "./device-fixtures";
import {
  clearDatabase,
  enrollDisposableWallet,
  putRawEntry,
  relyingParty,
} from "./sealed-wallet-fixtures";

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

it.effect("refuses to seal a phrase that derives another address", () =>
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

    expect(mismatchedSeal._tag).toBe("CorruptEnvelope");
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
