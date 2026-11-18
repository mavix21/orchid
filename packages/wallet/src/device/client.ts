import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Username, type WalletPort } from "../contract";
import type { KeyStore } from "./key-store";
import {
  type CreateOutcome,
  type DeviceOverview,
  InvalidUsername,
  NoWallet,
  Offline,
  type SavedOutcome,
  SavedWallet,
  UnsupportedDevice,
} from "./outcomes";

export * from "./outcomes";

export interface WalletClient {
  overview(): Promise<DeviceOverview>;
  saved(): Promise<SavedOutcome>;
  create(usernameText: string): Promise<CreateOutcome>;
}

export function makeWalletClient(port: WalletPort, store: KeyStore) {
  const create = Effect.fn("Device.create")(function* (usernameText: string) {
    const username = Schema.decodeUnknownOption(Username)(usernameText);

    if (Option.isNone(username)) return new InvalidUsername();

    const { openWallet } = yield* Effect.promise(() => import("./opening"));

    return yield* openWallet(port, store)(username.value);
  });

  const overview = Effect.fn("Device.overview")(function* () {
    const stored = yield* store.read();

    if (Option.isNone(stored)) return new NoWallet();

    return yield* port.overview(stored.value.address);
  });

  const saved = Effect.fn("Device.saved")(function* () {
    const stored = yield* store.read();

    return Option.match(stored, {
      onNone: () => new NoWallet(),
      onSome: (wallet) =>
        new SavedWallet({
          username: wallet.username,
          openingApproved: wallet.reserveSponsor !== undefined,
        }),
    });
  });

  const client: WalletClient = {
    saved: () =>
      saved().pipe(
        Effect.catchTag("KeyStoreUnavailable", () =>
          Effect.succeed(new UnsupportedDevice()),
        ),
        Effect.runPromise,
      ),
    overview: () =>
      overview().pipe(
        Effect.catchTags({
          KeyStoreUnavailable: () => Effect.succeed(new UnsupportedDevice()),
          WalletUnavailable: () => Effect.succeed(new Offline()),
        }),
        Effect.runPromise,
      ),
    create: (usernameText) =>
      create(usernameText).pipe(
        Effect.catchTags({
          KeyStoreUnavailable: () => Effect.succeed(new UnsupportedDevice()),
          WalletUnavailable: () => Effect.succeed(new Offline()),
        }),
        Effect.runPromise,
      ),
  };

  return client;
}
