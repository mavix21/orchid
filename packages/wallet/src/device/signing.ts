import { mnemonicToSeedSync } from "@scure/bip39";
import { Keypair } from "@stellar/stellar-sdk";
import type * as Arr from "effect/Array";
import { HDKey } from "micro-key-producer/slip10.js";
import { Approval, type SigningRequest } from "../contract";
import { signingPayload } from "../stellar/envelopes";
import type { SecretPhrase } from "./secret-phrase";

const stellarAccountPath = "m/44'/148'/0'";

export function signingKey(phrase: SecretPhrase): Keypair {
  return Keypair.fromRawEd25519Seed(
    HDKey.fromMasterSeed(mnemonicToSeedSync(phrase)).derive(stellarAccountPath)
      .privateKey,
  );
}

export function approveWithPhrase(
  phrase: SecretPhrase,
  requests: Arr.NonEmptyReadonlyArray<SigningRequest>,
): Arr.NonEmptyReadonlyArray<Approval> {
  const seed = mnemonicToSeedSync(phrase);
  const node = HDKey.fromMasterSeed(seed).derive(stellarAccountPath);

  try {
    const [first, ...rest] = requests;

    const sign = (request: SigningRequest) =>
      new Approval({ signature: node.sign(signingPayload(request.envelope)) });

    return [sign(first), ...rest.map(sign)];
  } finally {
    seed.fill(0);
    node.privateKey.fill(0);
    node.chainCode.fill(0);
  }
}
