import type { AccountAddress, LinkSecret, UnsignedEnvelope } from "../contract";

export interface SigningScheme {
  readonly derivationPath: string;
  readonly linkKeyInfo: Uint8Array;
  readonly address: (publicKey: Uint8Array) => AccountAddress;
  readonly linkSecret: (seed: Uint8Array) => LinkSecret;
  readonly linkSecretSeed: (secret: LinkSecret) => Uint8Array;
  readonly signingPayload: (envelope: UnsignedEnvelope) => Uint8Array;
}
