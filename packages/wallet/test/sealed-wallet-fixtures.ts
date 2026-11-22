import "fake-indexeddb/auto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { PasskeyChallenge, Username } from "../src/contract";
import { PinnedCredential } from "../src/device/assertion";
import {
  PublicDeviceWallet,
  SealedDeviceWallet,
} from "../src/device/key-store";
import {
  type LocalPhraseEnvelope,
  freshInstallationSalt,
  localEnvelopeVersion,
  localPhrasePrfInput,
  sealLocalEnvelope,
} from "../src/device/local-envelope";
import { generateSecretPhrase } from "../src/device/secret-phrase";
import { signingKey } from "../src/device/signing";
import { network } from "../src/stellar/network";
import { addressOf } from "./device-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";

export const relyingParty = {
  origin: "http://localhost:3000",
  rpId: "localhost",
};

const dummyChallenge = Schema.decodeSync(PasskeyChallenge)("A".repeat(43));

export type RawStoredEntry =
  | {
      readonly address: string;
      readonly username: string;
      readonly iv: string;
      readonly phrase: string;
    }
  | (Omit<typeof SealedDeviceWallet.Encoded, "version"> & {
      readonly version: number;
    })
  | (Omit<typeof SealedDeviceWallet.Encoded, "credential"> & {
      readonly credential: {
        readonly id: string;
        readonly publicKey: string;
        readonly algorithm: string;
      };
    })
  | (Omit<typeof SealedDeviceWallet.Encoded, "envelope"> & {
      readonly envelope: Omit<
        typeof LocalPhraseEnvelope.Encoded,
        "ciphertext"
      > & {
        readonly ciphertext: string;
      };
    })
  | typeof SealedDeviceWallet.Encoded
  | CryptoKey;

const withEntryStore = <A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
) =>
  new Promise<A>((resolve, reject) => {
    const request = indexedDB.open("orchid-device", 1);

    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains("entries"))
        request.result.createObjectStore("entries");
    });
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("success", () => {
      const transaction = request.result.transaction("entries", mode);
      const op = run(transaction.objectStore("entries"));

      op.addEventListener("error", () => reject(op.error));
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("complete", () => {
        request.result.close();
        resolve(op.result);
      });
    });
  });

export const clearDatabase = () =>
  withEntryStore("readwrite", (store) => store.clear());

export const storedEntry = (name: string) =>
  withEntryStore("readonly", (store) => store.get(name));

export const storedKeys = () =>
  withEntryStore("readonly", (store) => store.getAllKeys());

export const putRawEntry = (name: string, value: RawStoredEntry) =>
  withEntryStore("readwrite", (store) => store.put(value, name));

export const enrollDisposableWallet = (name = "maria") =>
  Effect.gen(function* () {
    const phrase = generateSecretPhrase();
    const key = signingKey(phrase);
    const address = addressOf(key);
    const username = Schema.decodeSync(Username)(name);
    const auth = new SoftwareAuthenticator(relyingParty.origin);
    const salt = freshInstallationSalt();
    const prfInput = yield* localPhrasePrfInput({ network, address, salt });

    const registered = Option.getOrThrow(
      yield* auth.passkeys.register(dummyChallenge, username, prfInput),
    );

    const credential = new PinnedCredential({
      id: registered.registration.id,
      publicKey: registered.registration.publicKey,
      algorithm: "ES256",
    });

    const prf = Redacted.make(Uint8Array.from(registered.prf));

    const sealed = yield* sealLocalEnvelope(
      {
        phrase,
        network,
        address,
        credentialId: credential.id,
        salt,
      },
      prf,
    );

    assertTagged(sealed, "EnvelopeSealed");

    const publicWallet = new PublicDeviceWallet({
      address,
      username,
      backup: "stored",
    });

    const record = new SealedDeviceWallet({
      version: localEnvelopeVersion,
      public: publicWallet,
      credential,
      envelope: sealed.envelope,
    });

    return {
      phrase,
      key,
      address,
      auth,
      salt,
      prf,
      credential,
      publicWallet,
      envelope: sealed.envelope,
      record,
    };
  });
