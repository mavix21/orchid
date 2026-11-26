import { ed25519 } from "@noble/curves/ed25519.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import type * as Arr from "effect/Array";
import { HDKey } from "micro-key-producer/slip10.js";
import { Approval, type LinkSecret, type SigningRequest } from "../contract";
import { stellarSigningScheme } from "../stellar/signing-scheme";
import type { SecretPhrase } from "./secret-phrase";
import type { SigningScheme } from "./signing-scheme";

function signingWith(scheme: SigningScheme) {
  const withPhraseKey = <A>(phrase: SecretPhrase, use: (key: HDKey) => A) => {
    const seed = mnemonicToSeedSync(phrase);
    const node = HDKey.fromMasterSeed(seed).derive(scheme.derivationPath);

    try {
      return use(node);
    } finally {
      seed.fill(0);
      node.privateKey.fill(0);
      node.chainCode.fill(0);
    }
  };

  const approveEach = (
    requests: Arr.NonEmptyReadonlyArray<SigningRequest>,
    sign: (payload: Uint8Array) => Uint8Array,
  ): Arr.NonEmptyReadonlyArray<Approval> => {
    const [first, ...rest] = requests;

    const approve = (request: SigningRequest) =>
      new Approval({
        signature: sign(scheme.signingPayload(request.envelope)),
      });

    return [approve(first), ...rest.map(approve)];
  };

  return {
    phraseAddress: (phrase: SecretPhrase) =>
      withPhraseKey(phrase, (key) => scheme.address(key.publicKeyRaw)),
    approveWithPhrase: (
      phrase: SecretPhrase,
      requests: Arr.NonEmptyReadonlyArray<SigningRequest>,
    ) =>
      withPhraseKey(phrase, (key) =>
        approveEach(requests, (payload) => key.sign(payload)),
      ),
    approveWithLinkSecret: (
      secret: LinkSecret,
      requests: Arr.NonEmptyReadonlyArray<SigningRequest>,
    ) => {
      const seed = scheme.linkSecretSeed(secret);

      try {
        return approveEach(requests, (payload) => ed25519.sign(payload, seed));
      } finally {
        seed.fill(0);
      }
    },
  };
}

export const { phraseAddress, approveWithPhrase, approveWithLinkSecret } =
  signingWith(stellarSigningScheme);
