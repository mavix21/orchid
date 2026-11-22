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
  PublicDeviceWallet,
  type PublicWalletUpdate,
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
  transferRevision: Schema.optional(Schema.Number),
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
      transferRevision: sealed.transferRevision,
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
      transferRevision: wallet.transferRevision,
      iv,
      phrase: new Uint8Array(phrase),
    }),
  );
}

async function readPublicWallet(): Promise<Option.Option<PublicDeviceWallet>> {
  const stored = Schema.decodeUnknownSync(
    Schema.UndefinedOr(PublicDeviceWallet),
  )(await readEntry(walletEntry));

  return Option.fromNullishOr(stored);
}

async function updatePublicWallet(
  update: (current: PublicDeviceWallet) => Option.Option<PublicDeviceWallet>,
): Promise<Option.Option<PublicWalletUpdate>> {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(entries, "readwrite");
    const objectStore = transaction.objectStore(entries);

    return await new Promise<Option.Option<PublicWalletUpdate>>(
      (resolve, reject) => {
        let result: Option.Option<PublicWalletUpdate> = Option.none();
        const request = objectStore.get(walletEntry);

        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          try {
            const sealed = Schema.decodeUnknownSync(
              Schema.UndefinedOr(SealedWallet),
            )(request.result);

            if (sealed === undefined) return;

            const current = new PublicDeviceWallet({
              address: sealed.address,
              username: sealed.username,
              reserveSponsor: sealed.reserveSponsor,
              backup: sealed.backup,
              transfer: sealed.transfer,
              approvedUntil: sealed.approvedUntil,
              linkReceipt: sealed.linkReceipt,
              transferRevision: sealed.transferRevision,
            });

            const next = update(current);

            if (Option.isNone(next)) {
              result = Option.some({ wallet: current, updated: false });

              return;
            }

            if (next.value.address !== current.address)
              throw new Error("Wallet address cannot change");

            objectStore.put(
              Schema.encodeSync(SealedWallet)({
                address: sealed.address,
                username: next.value.username,
                reserveSponsor: next.value.reserveSponsor,
                backup: next.value.backup,
                transfer: next.value.transfer,
                approvedUntil: next.value.approvedUntil,
                linkReceipt: next.value.linkReceipt,
                transferRevision: next.value.transferRevision,
                iv: sealed.iv,
                phrase: sealed.phrase,
              }),
              walletEntry,
            );
            result = Option.some({ wallet: next.value, updated: true });
          } catch (error) {
            transaction.abort();
            reject(error);
          }
        });

        transaction.addEventListener("complete", () => resolve(result));
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
      },
    );
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
  readPublic: () =>
    Effect.tryPromise({
      try: readPublicWallet,
      catch: (cause) => new KeyStoreUnavailable({ cause }),
    }),
  updatePublic: (update) =>
    Effect.tryPromise({
      try: () => updatePublicWallet(update),
      catch: (cause) => new KeyStoreUnavailable({ cause }),
    }),
};
