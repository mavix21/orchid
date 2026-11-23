import { Keypair } from "@stellar/stellar-sdk";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  BalanceId,
  CredentialId,
  LinkSecret,
} from "../contract";
import { canonicalTuple, sha256 } from "./canonical-digest";
import { aesGcmTagLength, envelopeIvLength } from "./local-envelope";

export const linkSealVersion = 1;

const linkSealDomain = "orchid-payment-link-secret-v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class SealedLinkSecret extends Schema.Class<SealedLinkSecret>(
  "@workspace/wallet/SealedLinkSecret",
)({
  version: Schema.Literal(linkSealVersion),
  network: Schema.NonEmptyString,
  wallet: AccountAddress,
  address: AccountAddress,
  credentialId: CredentialId,
  iv: Schema.Uint8ArrayFromBase64,
  ciphertext: Schema.Uint8ArrayFromBase64,
  fundedBalance: Schema.optional(BalanceId),
}) {}

export class LinkSecretOpened extends Data.TaggedClass("LinkSecretOpened")<{
  readonly secret: Redacted.Redacted<LinkSecret>;
}> {}

export class LinkSecretCorrupt extends Schema.TaggedClass<LinkSecretCorrupt>()(
  "LinkSecretCorrupt",
  {},
) {}

export interface LinkPrfContext {
  readonly network: string;
  readonly wallet: AccountAddress;
  readonly address: AccountAddress;
}

export interface LinkSealContext extends LinkPrfContext {
  readonly credentialId: CredentialId;
}

const linkTuple = (context: LinkPrfContext) =>
  canonicalTuple([
    encoder.encode(linkSealDomain),
    encoder.encode(context.network),
    encoder.encode(context.wallet),
    encoder.encode(context.address),
  ]);

export const linkPrfInput = (
  context: LinkPrfContext,
): Effect.Effect<Uint8Array<ArrayBuffer>> => sha256(linkTuple(context));

const linkKey = (
  prf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
  usage: "encrypt" | "decrypt",
) =>
  Effect.tryPromise(async () => {
    const rawPrf = Uint8Array.from(Redacted.value(prf));

    try {
      return await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(),
          info: encoder.encode(linkSealDomain),
        },
        await crypto.subtle.importKey("raw", rawPrf, "HKDF", false, [
          "deriveKey",
        ]),
        { name: "AES-GCM", length: 256 },
        false,
        [usage],
      );
    } finally {
      rawPrf.fill(0);
    }
  }).pipe(Effect.option);

const linkAddressOf = (secret: LinkSecret) => {
  try {
    return Option.some(Keypair.fromSecret(secret).publicKey());
  } catch {
    return Option.none();
  }
};

export const sealLinkSecret = Effect.fn("Device.sealLinkSecret")(function* (
  context: LinkSealContext,
  secret: LinkSecret,
  prf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
): Effect.fn.Return<Option.Option<SealedLinkSecret>> {
  if (
    context.network.length === 0 ||
    Redacted.value(prf).byteLength === 0 ||
    !Option.contains(linkAddressOf(secret), context.address)
  )
    return Option.none();

  const key = yield* linkKey(prf, "encrypt");

  if (Option.isNone(key)) return Option.none();

  const iv = crypto.getRandomValues(new Uint8Array(envelopeIvLength));

  const ciphertext = yield* Effect.tryPromise(async () => {
    const plaintext = encoder.encode(secret);

    try {
      return new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: linkTuple(context) },
          key.value,
          plaintext,
        ),
      );
    } finally {
      plaintext.fill(0);
    }
  }).pipe(Effect.option);

  return Option.map(
    ciphertext,
    (sealed) =>
      new SealedLinkSecret({
        version: linkSealVersion,
        network: context.network,
        wallet: context.wallet,
        address: context.address,
        credentialId: context.credentialId,
        iv,
        ciphertext: sealed,
      }),
  );
});

export const matchesLinkContext = (
  sealed: SealedLinkSecret,
  expected: LinkSealContext,
) =>
  sealed.network === expected.network &&
  sealed.wallet === expected.wallet &&
  sealed.address === expected.address &&
  sealed.credentialId === expected.credentialId &&
  sealed.iv.byteLength === envelopeIvLength &&
  sealed.ciphertext.byteLength > aesGcmTagLength;

export const openLinkSecret = Effect.fn("Device.openLinkSecret")(function* (
  sealed: SealedLinkSecret,
  expected: LinkSealContext,
  prf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
): Effect.fn.Return<LinkSecretOpened | LinkSecretCorrupt> {
  if (
    !matchesLinkContext(sealed, expected) ||
    Redacted.value(prf).byteLength === 0
  )
    return new LinkSecretCorrupt();

  const key = yield* linkKey(prf, "decrypt");

  if (Option.isNone(key)) return new LinkSecretCorrupt();

  const text = yield* Effect.tryPromise(async () => {
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(sealed.iv),
          additionalData: linkTuple(expected),
        },
        key.value,
        Uint8Array.from(sealed.ciphertext),
      ),
    );

    try {
      return decoder.decode(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }).pipe(Effect.option);

  const secret = Option.flatMap(text, Schema.decodeUnknownOption(LinkSecret));

  if (
    Option.isNone(secret) ||
    !Option.contains(linkAddressOf(secret.value), expected.address)
  )
    return new LinkSecretCorrupt();

  return new LinkSecretOpened({ secret: Redacted.make(secret.value) });
});
