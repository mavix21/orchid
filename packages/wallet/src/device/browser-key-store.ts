import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  PaymentLinkReceipt,
  TransferOrder,
  Username,
} from "../contract";
import {
  BackupState,
  DeviceWallet,
  type KeyStore,
  KeyStoreUnavailable,
  type LinkClearTarget,
  sameLinkState,
} from "./key-store";
import { SecretPhrase } from "./secret-phrase";

const databaseName = "orchid-device";
const entries = "entries";
const wrappingKeyEntry = "wrapping-key";
const walletEntry = "wallet";

const SealedWallet = Schema.Struct({
  address: AccountAddress,
  username: Username,
  reserveSponsor: Schema.optional(AccountAddress),
  backup: Schema.optional(BackupState),
  transfer: Schema.optional(TransferOrder),
  approvedUntil: Schema.optional(Schema.Number),
  linkReceipt: Schema.optional(PaymentLinkReceipt),
  iv: Schema.Uint8ArrayFromBase64,
  phrase: Schema.Uint8ArrayFromBase64,
});

function settle<A>(request: IDBRequest<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(databaseName, 1);

  request.addEventListener("upgradeneeded", () =>
    request.result.createObjectStore(entries),
  );

  return settle(request);
}

async function readEntry(name: string) {
  const database = await openDatabase();

  try {
    return await settle(
      database.transaction(entries).objectStore(entries).get(name),
    );
  } finally {
    database.close();
  }
}

async function writeEntry(
  name: string,
  value: CryptoKey | typeof SealedWallet.Encoded,
) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(entries, "readwrite");

    transaction.objectStore(entries).put(value, name);

    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

async function wrappingKey(): Promise<CryptoKey> {
  const stored = Schema.decodeUnknownOption(Schema.instanceOf(CryptoKey))(
    await readEntry(wrappingKeyEntry),
  );

  if (Option.isSome(stored)) return stored.value;

  const created = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  await writeEntry(wrappingKeyEntry, created);

  return created;
}

async function readWallet(): Promise<Option.Option<DeviceWallet>> {
  const sealed = Schema.decodeUnknownSync(Schema.UndefinedOr(SealedWallet))(
    await readEntry(walletEntry),
  );

  if (sealed === undefined) return Option.none();

  const phrase = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(sealed.iv) },
    await wrappingKey(),
    new Uint8Array(sealed.phrase),
  );

  return Option.some(
    new DeviceWallet({
      address: sealed.address,
      username: sealed.username,
      reserveSponsor: sealed.reserveSponsor,
      backup: sealed.backup,
      transfer: sealed.transfer,
      approvedUntil: sealed.approvedUntil,
      linkReceipt: sealed.linkReceipt,
      phrase: Schema.decodeSync(SecretPhrase)(new TextDecoder().decode(phrase)),
    }),
  );
}

async function writeWallet(wallet: DeviceWallet): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const phrase = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await wrappingKey(),
    new TextEncoder().encode(wallet.phrase),
  );

  await writeEntry(
    walletEntry,
    Schema.encodeSync(SealedWallet)({
      address: wallet.address,
      username: wallet.username,
      reserveSponsor: wallet.reserveSponsor,
      backup: wallet.backup,
      transfer: wallet.transfer,
      approvedUntil: wallet.approvedUntil,
      linkReceipt: wallet.linkReceipt,
      iv,
      phrase: new Uint8Array(phrase),
    }),
  );
}

async function clearSealedLink(expected: LinkClearTarget): Promise<void> {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(entries, "readwrite");
    const objectStore = transaction.objectStore(entries);

    await new Promise<void>((resolve, reject) => {
      const request = objectStore.get(walletEntry);

      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("success", () => {
        try {
          const sealed = Schema.decodeUnknownSync(
            Schema.UndefinedOr(SealedWallet),
          )(request.result);

          if (sealed !== undefined && sameLinkState(sealed, expected))
            objectStore.put(
              Schema.encodeSync(SealedWallet)({
                address: sealed.address,
                username: sealed.username,
                reserveSponsor: sealed.reserveSponsor,
                backup: sealed.backup,
                iv: sealed.iv,
                phrase: sealed.phrase,
              }),
              walletEntry,
            );
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      });

      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

export const browserKeyStore: KeyStore = {
  read: () =>
    Effect.tryPromise({
      try: readWallet,
      catch: (cause) => new KeyStoreUnavailable({ cause }),
    }),
  write: (wallet) =>
    Effect.tryPromise({
      try: () => writeWallet(wallet),
      catch: (cause) => new KeyStoreUnavailable({ cause }),
    }),
  clearLink: (expected) =>
    Effect.tryPromise({
      try: () => clearSealedLink(expected),
      catch: (cause) => new KeyStoreUnavailable({ cause }),
    }),
};
