import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair } from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  LinkCode,
  LinkSecret,
  encodeLinkCodeBytes,
  linkCodeEntropy,
  linkCodeEntropyLength,
} from "../contract";
import { networkPassphrase } from "../stellar/network";

const encoder = new TextEncoder();

const linkKeySalt = encoder.encode("orchid-payment-link-code-v1");

export interface LinkKey {
  readonly address: AccountAddress;
  readonly secret: LinkSecret;
}

const networkInfo = encoder.encode(networkPassphrase);

const keyFromEntropy = (entropy: Uint8Array): LinkKey => {
  const seed = hkdf(sha256, entropy, linkKeySalt, networkInfo, 32);

  try {
    const keypair = Keypair.fromRawEd25519Seed(seed);

    return {
      address: Schema.decodeSync(AccountAddress)(keypair.publicKey()),
      secret: Schema.decodeSync(LinkSecret)(keypair.secret()),
    };
  } finally {
    seed.fill(0);
  }
};

export const linkKeyOf = (code: LinkCode): Option.Option<LinkKey> =>
  Option.map(linkCodeEntropy(code), (entropy) => {
    try {
      return keyFromEntropy(entropy);
    } finally {
      entropy.fill(0);
    }
  });

export const generateLinkCode = (): LinkCode => {
  const entropy = crypto.getRandomValues(new Uint8Array(linkCodeEntropyLength));

  try {
    return Schema.decodeSync(LinkCode)(encodeLinkCodeBytes(entropy));
  } finally {
    entropy.fill(0);
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
