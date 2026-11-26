import type { AccountAddress, UnsignedEnvelope } from "../contract";

export interface LinkKey {
  readonly address: AccountAddress;
  readonly sign: (payload: Uint8Array) => Uint8Array;
}

export interface SigningScheme {
  readonly derivationPath: string;
  readonly address: (publicKey: Uint8Array) => AccountAddress;
  readonly linkKey: (entropy: Uint8Array) => LinkKey;
  readonly signingPayload: (envelope: UnsignedEnvelope) => Uint8Array;
}
