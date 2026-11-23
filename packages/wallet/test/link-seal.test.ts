import { expect, it } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CredentialId, LinkSecret } from "../src/contract";
import {
  type LinkSealContext,
  SealedLinkSecret,
  linkSealVersion,
  openLinkSecret,
  sealLinkSecret,
} from "../src/device/link-seal";
import { canonicalTuple } from "../src/device/canonical-digest";
import { network } from "../src/stellar/network";
import { addressOf } from "./device-fixtures";
import { assertTagged } from "./tagged";

const encoder = new TextEncoder();
const linkKey = Keypair.random();
const otherLink = addressOf(Keypair.random());

const context: LinkSealContext = {
  network,
  wallet: addressOf(Keypair.random()),
  address: addressOf(linkKey),
  credentialId: Schema.decodeSync(CredentialId)("Y3JlZGVudGlhbA"),
};

const secret = Schema.decodeSync(LinkSecret)(linkKey.secret());
const prfBytes = crypto.getRandomValues(new Uint8Array(32));
const prf = () => Redacted.make(Uint8Array.from(prfBytes));

const sealedText = (plaintext: string) =>
  Effect.promise(async () => {
    const hkdf = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(prfBytes),
      "HKDF",
      false,
      ["deriveKey"],
    );

    const key = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: encoder.encode("orchid-payment-link-secret-v1"),
      },
      hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: canonicalTuple(
          [
            "orchid-payment-link-secret-v1",
            context.network,
            context.wallet,
            context.address,
          ].map((part) => encoder.encode(part)),
        ),
      },
      key,
      encoder.encode(plaintext),
    );

    return new SealedLinkSecret({
      version: linkSealVersion,
      ...context,
      iv,
      ciphertext: new Uint8Array(ciphertext),
    });
  });

const sealed = sealLinkSecret(context, secret, prf()).pipe(
  Effect.map(Option.getOrThrow),
);

const withBrokenChecksum = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;

it.effect("opens a sealed link secret only with its own context and PRF", () =>
  Effect.gen(function* () {
    const opened = yield* openLinkSecret(yield* sealed, context, prf());

    assertTagged(opened, "LinkSecretOpened");
    expect(Redacted.value(opened.secret)).toBe(secret);
  }),
);

it.effect.each([
  {
    name: "another credential's PRF output",
    tampered: sealed,
    output: () => Redacted.make(crypto.getRandomValues(new Uint8Array(32))),
    expected: context,
  },
  {
    name: "a record sealed under another credential",
    tampered: Effect.map(
      sealed,
      (record) =>
        new SealedLinkSecret({
          ...record,
          credentialId: Schema.decodeSync(CredentialId)("b3RoZXI"),
        }),
    ),
    output: prf,
    expected: context,
  },
  {
    name: "a record relabelled to another link address",
    tampered: Effect.map(
      sealed,
      (record) => new SealedLinkSecret({ ...record, address: otherLink }),
    ),
    output: prf,
    expected: { ...context, address: otherLink },
  },
  {
    name: "a flipped ciphertext byte",
    tampered: Effect.map(sealed, (record) => {
      const ciphertext = Uint8Array.from(record.ciphertext);

      ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;

      return new SealedLinkSecret({ ...record, ciphertext });
    }),
    output: prf,
    expected: context,
  },
  {
    name: "a secret with an invalid StrKey checksum",
    tampered: sealedText(withBrokenChecksum),
    output: prf,
    expected: context,
  },
  {
    name: "a secret whose key is not the link address",
    tampered: sealedText(Keypair.random().secret()),
    output: prf,
    expected: context,
  },
])("refuses $name as LinkSecretCorrupt", ({ tampered, output, expected }) =>
  Effect.gen(function* () {
    const opened = yield* openLinkSecret(yield* tampered, expected, output());

    expect(opened._tag).toBe("LinkSecretCorrupt");
  }),
);
