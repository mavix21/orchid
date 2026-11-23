import "fake-indexeddb/auto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { browserKeyStore } from "../src/device/browser-key-store";
import { makeWalletEffects } from "../src/device/client";
import { memoryKeyStore, unusedPort } from "./device-fixtures";
import {
  clearDatabase,
  enrollDisposableWallet,
  relyingParty,
} from "./sealed-wallet-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";

const deviceWith = (auth: SoftwareAuthenticator) =>
  makeWalletEffects(unusedPort(), memoryKeyStore(), auth.passkeys, {
    store: browserKeyStore,
    ceremony: auth.assertions,
    relyingParty: () => relyingParty,
  });

it.effect("unlocks on a verified assertion that asks for no PRF output", () =>
  Effect.gen(function* () {
    yield* Effect.promise(clearDatabase);

    const enrolled = yield* enrollDisposableWallet();

    yield* browserKeyStore.installSealed(enrolled.record);

    const outcome = yield* deviceWith(enrolled.auth).unlock();

    expect(outcome._tag).toBe("Unlocked");
    expect(enrolled.auth.requested).toEqual([Option.none()]);
  }),
);

it.effect(
  "refuses an assertion from a credential other than the pinned one",
  () =>
    Effect.gen(function* () {
      yield* Effect.promise(clearDatabase);

      const enrolled = yield* enrollDisposableWallet();

      yield* browserKeyStore.installSealed(enrolled.record);

      const other = new SoftwareAuthenticator(relyingParty.origin);

      other.forge("b3RoZXItY3JlZGVudGlhbA");

      const outcome = yield* deviceWith(other).unlock();

      expect(outcome._tag).toBe("WrongCredential");
    }),
);

it.effect("reports that no wallet is held when the device has none", () =>
  Effect.gen(function* () {
    yield* Effect.promise(clearDatabase);

    const outcome = yield* deviceWith(
      new SoftwareAuthenticator(relyingParty.origin),
    ).unlock();

    expect(outcome._tag).toBe("NoWallet");
  }),
);
