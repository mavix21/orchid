import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AccountAddress, LinkSecret } from "../contract";
import { stellarSigningScheme } from "../stellar/signing-scheme";
import type { SigningScheme } from "./signing-scheme";

const linkCodeVersion = 1;
const linkCodeEntropyLength = 16;
const linkCodeChecksumLength = 2;
const linkCodeByteLength = 1 + linkCodeEntropyLength + linkCodeChecksumLength;
const linkCodeTextLength = 25;

const linkCodeChecksum = (body: Uint8Array) =>
  sha256(body).subarray(0, linkCodeChecksumLength);

const sameChecksum = (bytes: Uint8Array) =>
  linkCodeChecksum(bytes.subarray(0, -linkCodeChecksumLength)).every(
    (byte, index) =>
      byte === bytes[linkCodeByteLength - linkCodeChecksumLength + index],
  );

const decodeBase58 = Option.liftThrowable(base58.decode);

const linkCodeEntropy = (text: string): Option.Option<Uint8Array> =>
  Option.some(text).pipe(
    Option.filter((candidate) => candidate.length === linkCodeTextLength),
    Option.flatMap(decodeBase58),
    Option.filter(
      (bytes) =>
        bytes.length === linkCodeByteLength &&
        bytes[0] === linkCodeVersion &&
        sameChecksum(bytes) &&
        base58.encode(bytes) === text,
    ),
    Option.map((bytes) => {
      const entropy = bytes.slice(1, 1 + linkCodeEntropyLength);

      bytes.fill(0);

      return entropy;
    }),
  );

export const LinkCode = Schema.String.check(
  Schema.makeFilter((text) => Option.isSome(linkCodeEntropy(text))),
).pipe(Schema.brand("LinkCode"));

export type LinkCode = typeof LinkCode.Type;

const encoder = new TextEncoder();

const linkKeySalt = encoder.encode("orchid-payment-link-code-v1");

export interface LinkKey {
  readonly address: AccountAddress;
  readonly secret: LinkSecret;
}

const keyFromEntropy = (
  scheme: SigningScheme,
  entropy: Uint8Array,
): LinkKey => {
  const seed = hkdf(sha256, entropy, linkKeySalt, scheme.linkKeyInfo, 32);

  try {
    return {
      address: scheme.address(ed25519.getPublicKey(seed)),
      secret: scheme.linkSecret(seed),
    };
  } finally {
    seed.fill(0);
  }
};

export const linkKeyOf = (code: LinkCode): Option.Option<LinkKey> =>
  Option.map(linkCodeEntropy(code), (entropy) => {
    try {
      return keyFromEntropy(stellarSigningScheme, entropy);
    } finally {
      entropy.fill(0);
    }
  });

export const generateLinkCode = (): LinkCode => {
  const body = new Uint8Array(1 + linkCodeEntropyLength);

  body[0] = linkCodeVersion;
  crypto.getRandomValues(body.subarray(1));

  const bytes = Uint8Array.of(...body, ...linkCodeChecksum(body));

  try {
    return Schema.decodeSync(LinkCode)(base58.encode(bytes));
  } finally {
    body.fill(0);
    bytes.fill(0);
  }
};

export const linkPath = (code: LinkCode) => `/r#${code}`;

export interface ReadLinkCode {
  readonly code: LinkCode;
  readonly link: AccountAddress;
}

export const readLinkCode = (fragment: string): Option.Option<ReadLinkCode> =>
  Option.flatMap(Schema.decodeUnknownOption(LinkCode)(fragment), (code) =>
    Option.map(linkKeyOf(code), (key) => ({ code, link: key.address })),
  );
