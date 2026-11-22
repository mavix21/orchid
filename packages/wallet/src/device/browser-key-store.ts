import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { network } from "../stellar/network";
import {
  CorruptDeviceWallet,
  KeyStoreUnavailable,
  PublicDeviceWallet,
  type PublicWalletUpdate,
  SealedDeviceWallet,
  type SealedKeyStore,
} from "./key-store";
import { localEnvelopeVersion, matchesEnvelopeContext } from "./local-envelope";

const databaseName = "orchid-device";
const entries = "entries";
const walletEntry = "wallet";

const StoredVersion = Schema.Struct({
  version: Schema.Literal(localEnvelopeVersion),
});

const isCurrentVersion = Schema.is(StoredVersion);
const decodeStoredWallet = Schema.decodeUnknownOption(SealedDeviceWallet);

function settle<A>(request: IDBRequest<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(databaseName, 1);

  request.addEventListener("upgradeneeded", () => {
    if (!request.result.objectStoreNames.contains(entries))
      request.result.createObjectStore(entries);
  });

  return settle(request);
}

async function readSealedWallet(): Promise<Option.Option<SealedDeviceWallet>> {
  const database = await openDatabase();

  try {
    const raw = await settle(
      database.transaction(entries).objectStore(entries).get(walletEntry),
    );

    if (!isCurrentVersion(raw)) return Option.none();

    const decoded = decodeStoredWallet(raw);

    if (Option.isNone(decoded)) throw new CorruptDeviceWallet();

    return decoded;
  } finally {
    database.close();
  }
}

async function readPublicWallet(): Promise<Option.Option<PublicDeviceWallet>> {
  return Option.map(await readSealedWallet(), (stored) => stored.public);
}

async function writeSealedWallet(wallet: SealedDeviceWallet): Promise<void> {
  if (
    !matchesEnvelopeContext(wallet.envelope, {
      network,
      address: wallet.public.address,
      credentialId: wallet.credential.id,
    })
  )
    throw new Error("Sealed wallet envelope does not match wallet context");

  const encoded = Schema.encodeSync(SealedDeviceWallet)(wallet);
  const database = await openDatabase();

  try {
    const transaction = database.transaction(entries, "readwrite");
    const objectStore = transaction.objectStore(entries);

    objectStore.clear();
    objectStore.put(encoded, walletEntry);

    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
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
            if (!isCurrentVersion(request.result)) return;

            const stored = decodeStoredWallet(request.result);

            if (Option.isNone(stored)) throw new CorruptDeviceWallet();

            const current = stored.value.public;
            const next = update(current);

            if (Option.isNone(next)) {
              result = Option.some({ wallet: current, updated: false });

              return;
            }

            if (next.value.address !== current.address)
              throw new Error("Wallet address cannot change");

            objectStore.put(
              Schema.encodeSync(SealedDeviceWallet)(
                new SealedDeviceWallet({
                  version: stored.value.version,
                  public: next.value,
                  credential: stored.value.credential,
                  envelope: stored.value.envelope,
                }),
              ),
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

function installable(
  current: Option.Option<SealedDeviceWallet>,
  candidate: SealedDeviceWallet,
): Option.Option<SealedDeviceWallet> {
  if (Option.isNone(current)) return Option.some(candidate);

  if (
    !matchesEnvelopeContext(current.value.envelope, {
      network,
      address: current.value.public.address,
      credentialId: current.value.credential.id,
    })
  )
    throw new CorruptDeviceWallet();

  if (current.value.public.address !== candidate.public.address)
    return Option.none();

  return Option.some(
    new SealedDeviceWallet({
      version: candidate.version,
      public: new PublicDeviceWallet({
        ...current.value.public,
        backup: "stored",
      }),
      credential: candidate.credential,
      envelope: candidate.envelope,
    }),
  );
}

async function installSealedWallet(
  candidate: SealedDeviceWallet,
): Promise<Option.Option<SealedDeviceWallet>> {
  if (
    !matchesEnvelopeContext(candidate.envelope, {
      network,
      address: candidate.public.address,
      credentialId: candidate.credential.id,
    })
  )
    throw new Error("Sealed wallet envelope does not match wallet context");

  const database = await openDatabase();

  try {
    const transaction = database.transaction(entries, "readwrite");
    const objectStore = transaction.objectStore(entries);

    return await new Promise<Option.Option<SealedDeviceWallet>>(
      (resolve, reject) => {
        let result: Option.Option<SealedDeviceWallet> = Option.none();
        const request = objectStore.get(walletEntry);

        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          try {
            let current = Option.none<SealedDeviceWallet>();

            if (request.result !== undefined) {
              if (!isCurrentVersion(request.result))
                throw new CorruptDeviceWallet();

              current = decodeStoredWallet(request.result);

              if (Option.isNone(current)) throw new CorruptDeviceWallet();
            }

            const next = installable(current, candidate);

            if (Option.isNone(next)) return;

            objectStore.clear();
            objectStore.put(
              Schema.encodeSync(SealedDeviceWallet)(next.value),
              walletEntry,
            );
            result = next;
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

export const browserKeyStore: SealedKeyStore = {
  readPublic: () =>
    Effect.tryPromise({
      try: readPublicWallet,
      catch: (cause) =>
        cause instanceof CorruptDeviceWallet
          ? cause
          : new KeyStoreUnavailable({ cause }),
    }),
  updatePublic: (update) =>
    Effect.tryPromise({
      try: () => updatePublicWallet(update),
      catch: (cause) =>
        cause instanceof CorruptDeviceWallet
          ? cause
          : new KeyStoreUnavailable({ cause }),
    }),
  readSealed: () =>
    Effect.tryPromise({
      try: readSealedWallet,
      catch: (cause) =>
        cause instanceof CorruptDeviceWallet
          ? cause
          : new KeyStoreUnavailable({ cause }),
    }),
  writeSealed: (wallet) =>
    Effect.tryPromise({
      try: () => writeSealedWallet(wallet),
      catch: (cause) => new KeyStoreUnavailable({ cause }),
    }),
  installSealed: (candidate) =>
    Effect.tryPromise({
      try: () => installSealedWallet(candidate),
      catch: (cause) =>
        cause instanceof CorruptDeviceWallet
          ? cause
          : new KeyStoreUnavailable({ cause }),
    }),
};
