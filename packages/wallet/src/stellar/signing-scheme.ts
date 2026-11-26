import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { StrKey } from "@stellar/stellar-sdk";
import * as Schema from "effect/Schema";
import { AccountAddress } from "../contract";
import type { SigningScheme } from "../device/signing-scheme";
import { signingPayload } from "./envelopes";
import { networkPassphrase } from "./network";

const encoder = new TextEncoder();
const linkKeySalt = encoder.encode("orchid-payment-link-code-v1");
const linkKeyInfo = encoder.encode(networkPassphrase);

export const stellarLinkSeed = (entropy: Uint8Array) =>
  hkdf(sha256, entropy, linkKeySalt, linkKeyInfo, 32);

const address = (publicKey: Uint8Array) =>
  Schema.decodeSync(AccountAddress)(StrKey.encodeEd25519PublicKey(publicKey));

export const stellarSigningScheme: SigningScheme = {
  derivationPath: "m/44'/148'/0'",
  address,
  linkKey: (entropy) => {
    const seed = stellarLinkSeed(entropy);

    return {
      address: address(ed25519.getPublicKey(seed)),
      sign: (payload) => ed25519.sign(payload, seed),
    };
  },
  signingPayload,
};
