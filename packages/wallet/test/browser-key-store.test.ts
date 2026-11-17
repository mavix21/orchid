import "fake-indexeddb/auto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress, Username } from "../src/contract";
import { browserKeyStore } from "../src/device/browser-key-store";
import { DeviceWallet } from "../src/device/key-store";
import { generateSecretPhrase } from "../src/device/secret-phrase";
import { signingKey } from "../src/device/signing";

const phrase = generateSecretPhrase();

const wallet = new DeviceWallet({
  phrase,
  address: Schema.decodeSync(AccountAddress)(signingKey(phrase).publicKey()),
  username: Schema.decodeSync(Username)("maria"),
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
    yield* browserKeyStore.write(
      new DeviceWallet({ ...wallet, reserveSponsor: wallet.address }),
    );

    expect(yield* browserKeyStore.read()).toEqual(
      Option.some(
        new DeviceWallet({ ...wallet, reserveSponsor: wallet.address }),
      ),
    );

    const text = yield* Effect.promise(storedText);

    expect(text).toContain(wallet.address);
    expect(text).not.toContain(phrase);
  }),
);
