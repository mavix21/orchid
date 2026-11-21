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
  baseAsset,
} from "../src/contract";
import { browserKeyStore } from "../src/device/browser-key-store";
import { DeviceWallet, clearStoredLink } from "../src/device/key-store";
import { addressOf, seededDeviceWallet } from "./device-fixtures";

const wallet = seededDeviceWallet();

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

const storedText = () =>
  new Promise<string>((resolve, reject) => {
    const request = indexedDB.open("orchid-device");

    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("success", () => {
      const read = request.result
        .transaction("entries")
        .objectStore("entries")
        .get("wallet");

      read.addEventListener("error", () => reject(read.error));
      read.addEventListener("success", () => {
        request.result.close();
        resolve(JSON.stringify(read.result));
      });
    });
  });

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

    yield* clearStoredLink(browserKeyStore, {
      address: wallet.address,
      transferId: orderA.id,
      approvedUntil: 100,
      receipt: receiptA,
    });

    expect(yield* browserKeyStore.read()).toEqual(Option.some(withB));

    yield* clearStoredLink(browserKeyStore, {
      address: wallet.address,
      transferId: orderB.id,
      approvedUntil: 200,
      receipt: receiptB,
    });

    expect(yield* browserKeyStore.read()).toEqual(Option.some(wallet));
  }),
);
