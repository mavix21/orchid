import { mnemonicToSeedSync } from "@scure/bip39";
import type * as Arr from "effect/Array";
import { HDKey } from "micro-key-producer/slip10.js";
import { Approval, type SigningRequest } from "../contract";
import { signingScheme } from "../device-network";
import type { SecretPhrase } from "./secret-phrase";
import type { LinkKey, SigningScheme } from "./signing-scheme";

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
    approveWithLinkKey: (
      key: LinkKey,
      requests: Arr.NonEmptyReadonlyArray<SigningRequest>,
    ) => approveEach(requests, key.sign),
  };
}

export const { phraseAddress, approveWithPhrase, approveWithLinkKey } =
  signingWith(signingScheme);
