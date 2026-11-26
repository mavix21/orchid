import { StrKey } from "@stellar/stellar-sdk";
import * as Schema from "effect/Schema";
import { AccountAddress, LinkSecret } from "../contract";
import type { SigningScheme } from "../device/signing-scheme";
import { signingPayload } from "./envelopes";
import { networkPassphrase } from "./network";

export const stellarSigningScheme: SigningScheme = {
  derivationPath: "m/44'/148'/0'",
  linkKeyInfo: new TextEncoder().encode(networkPassphrase),
  address: (publicKey) =>
    Schema.decodeSync(AccountAddress)(StrKey.encodeEd25519PublicKey(publicKey)),
  linkSecret: (seed) =>
    Schema.decodeSync(LinkSecret)(StrKey.encodeEd25519SecretSeed(seed)),
  linkSecretSeed: (secret) => StrKey.decodeEd25519SecretSeed(secret),
  signingPayload,
};
