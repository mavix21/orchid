import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  BackupStored,
  Holding,
  Username,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import {
  DeviceWallet,
  type KeyStore,
  type KeyStoreUnavailable,
  remember,
} from "./key-store";
import {
  type BackUpOutcome,
  BackupUnsupported,
  type CreateOutcome,
  type DeviceOverview,
  InvalidUsername,
  NoWallet,
  Offline,
  type RestoreOutcome,
  type SavedOutcome,
  SavedWallet,
  type SendOutcome,
  type TransferIntent,
  UnsupportedDevice,
} from "./outcomes";
import type { PasskeyCancelled, PasskeyFailed, Passkeys } from "./passkeys";

export * from "./outcomes";

export * from "./passkeys";

export interface WalletClient {
  overview(): Promise<DeviceOverview>;
  saved(): Promise<SavedOutcome>;
  create(usernameText: string): Promise<CreateOutcome>;
  backUp(): Promise<BackUpOutcome>;
  restore(): Promise<RestoreOutcome>;
  send(intent: TransferIntent): Promise<SendOutcome>;
}

export function makeWalletClient(
  port: WalletPort,
  store: KeyStore,
  passkeys: Passkeys,
) {
  const backups = Effect.promise(() => import("./backup")).pipe(
    Effect.map(({ deviceBackup }) => deviceBackup(port, passkeys, store)),
  );

  const sending = Effect.promise(() => import("./sending")).pipe(
    Effect.map(({ sendTransfer }) => sendTransfer(port, store)),
  );

  const create = Effect.fn("Device.create")(function* (usernameText: string) {
    const username = Schema.decodeUnknownOption(Username)(usernameText);

    if (Option.isNone(username)) return new InvalidUsername();

    const { openWallet } = yield* Effect.promise(() => import("./opening"));

    return yield* openWallet(port, store, passkeys)(username.value);
  });

  const backUp = Effect.fn("Device.backUp")(function* () {
    const stored = yield* store.read();

    if (Option.isNone(stored)) return new NoWallet();

    if (stored.value.backup === "stored") return new BackupStored();

    const enrolled = yield* (yield* backups).enroll(stored.value);

    return enrolled instanceof DeviceWallet
      ? enrolled.backup === "stored"
        ? new BackupStored()
        : new BackupUnsupported()
      : enrolled;
  });

  const restore = Effect.fn("Device.restore")(function* () {
    return yield* (yield* backups).restore();
  });

  const overview = Effect.fn("Device.overview")(function* () {
    const stored = yield* store.read();

    if (Option.isNone(stored)) return new NoWallet();

    const overview = yield* port.overview(stored.value.address);

    const current = yield* store.read();

    if (
      overview instanceof Holding &&
      Option.isSome(overview.reserveSponsor) &&
      Option.isSome(current) &&
      current.value.address === stored.value.address &&
      current.value.reserveSponsor === undefined
    )
      yield* remember(
        store,
        new DeviceWallet({
          ...current.value,
          reserveSponsor: overview.reserveSponsor.value,
        }),
      );

    return overview;
  });

  const send = (intent: TransferIntent) =>
    sending.pipe(Effect.flatMap((sendIntent) => sendIntent(intent)));

  const saved = Effect.fn("Device.saved")(function* () {
    const stored = yield* store.read();

    return Option.match(stored, {
      onNone: () => new NoWallet(),
      onSome: (wallet) =>
        new SavedWallet({
          username: wallet.username,
          openingApproved: wallet.reserveSponsor !== undefined,
          backup: wallet.backup ?? "none",
        }),
    });
  });

  const settle = <A>(
    program: Effect.Effect<
      A,
      KeyStoreUnavailable | WalletUnavailable | PasskeyCancelled | PasskeyFailed
    >,
  ) =>
    program.pipe(
      Effect.catchTags({
        KeyStoreUnavailable: () => Effect.succeed(new UnsupportedDevice()),
        WalletUnavailable: () => Effect.succeed(new Offline()),
        PasskeyCancelled: (cancelled) => Effect.succeed(cancelled),
        PasskeyFailed: (failed) => Effect.succeed(failed),
      }),
      Effect.runPromise,
    );

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
    create: (usernameText) => settle(create(usernameText)),
    backUp: () => settle(backUp()),
    restore: () => settle(restore()),
    send: (intent) =>
      send(intent).pipe(
        Effect.catchTags({
          KeyStoreUnavailable: () => Effect.succeed(new UnsupportedDevice()),
          WalletUnavailable: () => Effect.succeed(new Offline()),
        }),
        Effect.runPromise,
      ),
  };

  return client;
}
