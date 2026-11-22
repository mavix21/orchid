import "fake-indexeddb/auto";
import { expect, it } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AddressRecipient,
  BalanceId,
  PaymentLinkReceipt,
  PaymentLinkRecipient,
  PositiveAmount,
  TransferId,
  TransferOrder,
  Username,
  baseAsset,
} from "../src/contract";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  DeviceWallet,
  PublicDeviceWallet,
  clearStoredLink,
  publicWalletOf,
} from "../src/device/key-store";
import { addressOf, seededDeviceWallet } from "./device-fixtures";

const wallet = seededDeviceWallet();

const Ciphertext = Schema.Struct({
  iv: Schema.String,
  phrase: Schema.String,
});

const resumable = new DeviceWallet({
  ...wallet,
  transfer: new TransferOrder({
    id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
    from: wallet.address,
    to: AddressRecipient.make({ value: wallet.address }),
    asset: baseAsset,
    amount: Schema.decodeSync(PositiveAmount)("10000000"),
    memo: { type: "id", value: "7" },
  }),
});

const withEntryStore = <A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
) =>
  new Promise<A>((resolve, reject) => {
    const request = indexedDB.open("orchid-device");

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

const storedEntry = (name: string) =>
  withEntryStore("readonly", (store) => store.get(name));

const removeEntry = (name: string) =>
  withEntryStore("readwrite", (store) => store.delete(name));

const restoreEntry = (name: string, value: CryptoKey) =>
  withEntryStore("readwrite", (store) => store.put(value, name));

const storedText = () =>
  storedEntry("wallet").then((value) => JSON.stringify(value));

const storedCiphertext = () =>
  storedEntry("wallet").then((value) =>
    Schema.decodeUnknownSync(Ciphertext)(value),
  );

it.effect("keeps the secret phrase encrypted at rest and reads it back", () =>
  Effect.gen(function* () {
    expect(yield* browserKeyStore.read()).toEqual(Option.none());

    yield* browserKeyStore.write(wallet);
    yield* browserKeyStore.write(resumable);

    expect(yield* browserKeyStore.read()).toEqual(Option.some(resumable));
    expect(yield* Effect.promise(storedText)).not.toContain(wallet.phrase);

    const amount = Schema.decodeSync(PositiveAmount)("10000000");
    const linkA = addressOf(Keypair.random());
    const linkB = addressOf(Keypair.random());
    const balanceA = Schema.decodeSync(BalanceId)(`00000000${"a".repeat(64)}`);
    const balanceB = Schema.decodeSync(BalanceId)(`00000000${"b".repeat(64)}`);

    const orderA = new TransferOrder({
      id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
      from: wallet.address,
      to: PaymentLinkRecipient.make({ value: linkA }),
      asset: baseAsset,
      amount,
    });

    const orderB = new TransferOrder({
      id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
      from: wallet.address,
      to: PaymentLinkRecipient.make({ value: linkB }),
      asset: baseAsset,
      amount,
    });

    const receiptA = new PaymentLinkReceipt({
      network: "testnet",
      address: linkA,
      asset: baseAsset,
      amount,
      balance: balanceA,
      attempts: [balanceA],
    });

    const receiptB = new PaymentLinkReceipt({
      network: "testnet",
      address: linkB,
      asset: baseAsset,
      amount,
      balance: balanceB,
      attempts: [balanceB],
    });

    const withB = new DeviceWallet({
      ...wallet,
      transfer: orderB,
      approvedUntil: 200,
      linkReceipt: receiptB,
    });

    yield* browserKeyStore.write(withB);

    const beforeCiphertext = yield* Effect.promise(storedCiphertext);

    const wrappingKey = Schema.decodeUnknownSync(Schema.instanceOf(CryptoKey))(
      yield* Effect.promise(() => storedEntry("wrapping-key")),
    );

    yield* Effect.promise(() => removeEntry("wrapping-key"));

    expect(yield* browserKeyStore.readPublic()).toEqual(
      Option.some(publicWalletOf(withB)),
    );

    const nextUsername = Schema.decodeSync(Username)("ana");
    const nextSponsor = addressOf(Keypair.random());

    const updated = yield* browserKeyStore.updatePublic((current) =>
      Option.some(
        new PublicDeviceWallet({
          ...current,
          username: nextUsername,
          reserveSponsor: nextSponsor,
        }),
      ),
    );

    const expectedWithB = new PublicDeviceWallet({
      ...publicWalletOf(withB),
      username: nextUsername,
      reserveSponsor: nextSponsor,
    });

    expect(updated).toEqual(
      Option.some({ wallet: expectedWithB, updated: true }),
    );

    yield* clearStoredLink(browserKeyStore, {
      address: wallet.address,
      transferId: orderA.id,
      approvedUntil: 100,
      receipt: receiptA,
    });

    expect(yield* browserKeyStore.readPublic()).toEqual(
      Option.some(expectedWithB),
    );

    yield* clearStoredLink(browserKeyStore, {
      address: wallet.address,
      transferId: orderB.id,
      approvedUntil: 200,
      receipt: receiptB,
    });

    const expectedCleared = new PublicDeviceWallet({
      ...publicWalletOf(wallet),
      username: nextUsername,
      reserveSponsor: nextSponsor,
    });

    expect(yield* browserKeyStore.readPublic()).toEqual(
      Option.some(expectedCleared),
    );
    expect(yield* Effect.promise(storedCiphertext)).toEqual(beforeCiphertext);

    yield* Effect.promise(() => restoreEntry("wrapping-key", wrappingKey));

    expect(yield* browserKeyStore.read()).toEqual(
      Option.some(
        new DeviceWallet({
          ...expectedCleared,
          phrase: wallet.phrase,
        }),
      ),
    );
  }),
);
