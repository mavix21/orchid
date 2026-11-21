import "fake-indexeddb/auto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AddressRecipient,
  PositiveAmount,
  TransferId,
  TransferOrder,
  baseAsset,
} from "../src/contract";
import { browserKeyStore } from "../src/device/browser-key-store";
import { DeviceWallet } from "../src/device/key-store";
import { seededDeviceWallet } from "./device-fixtures";

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
  }),
);
