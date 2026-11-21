import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  BackupStored,
  type TransferId,
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
  type CancelPaymentLinkOutcome,
  type CreateOutcome,
  type CreatePaymentLinkOutcome,
  type DeviceOverview,
  InvalidUsername,
  NoWallet,
  type PaymentLinkIntent,
  type PaymentLinkTarget,
  type PaymentLinksOutcome,
  type PaymentReview,
  type ResolvePaymentLinkOutcome,
  type RestoreOutcome,
  type ResumeOutcome,
  type ReviewOutcome,
  type SavedOutcome,
  SavedWallet,
  type SendOutcome,
  type TransferIntent,
  UnsupportedDevice,
} from "./outcomes";
import type { PasskeyCancelled, PasskeyFailed, Passkeys } from "./passkeys";
import { loadFromServer } from "./reaching";

export * from "./outcomes";

export * from "./passkeys";

export { loadFromServer, unreachedServer } from "./reaching";

export interface WalletClient {
  overview(): Promise<DeviceOverview>;
  saved(): Promise<SavedOutcome>;
  create(usernameText: string): Promise<CreateOutcome>;
  backUp(): Promise<BackUpOutcome>;
  restore(): Promise<RestoreOutcome>;
  send(intent: TransferIntent): Promise<SendOutcome>;
  review(intent: TransferIntent): Promise<ReviewOutcome>;
  confirm(review: PaymentReview): Promise<ResumeOutcome>;
  resume(id: TransferId): Promise<ResumeOutcome>;
  createPaymentLink(
    intent: PaymentLinkIntent,
  ): Promise<CreatePaymentLinkOutcome>;
  paymentLinks(): Promise<PaymentLinksOutcome>;
  resolvePaymentLink(): Promise<ResolvePaymentLinkOutcome>;
  cancelPaymentLink(
    target: PaymentLinkTarget,
  ): Promise<CancelPaymentLinkOutcome>;
}

export interface WalletEffects {
  overview(): Effect.Effect<DeviceOverview>;
  saved(): Effect.Effect<SavedOutcome>;
  create(usernameText: string): Effect.Effect<CreateOutcome>;
  backUp(): Effect.Effect<BackUpOutcome>;
  restore(): Effect.Effect<RestoreOutcome>;
  send(intent: TransferIntent): Effect.Effect<SendOutcome>;
  review(intent: TransferIntent): Effect.Effect<ReviewOutcome>;
  confirm(review: PaymentReview): Effect.Effect<ResumeOutcome>;
  resume(id: TransferId): Effect.Effect<ResumeOutcome>;
  createPaymentLink(
    intent: PaymentLinkIntent,
  ): Effect.Effect<CreatePaymentLinkOutcome>;
  paymentLinks(): Effect.Effect<PaymentLinksOutcome>;
  resolvePaymentLink(): Effect.Effect<ResolvePaymentLinkOutcome>;
  cancelPaymentLink(
    target: PaymentLinkTarget,
  ): Effect.Effect<CancelPaymentLinkOutcome>;
}

export function makeWalletEffects(
  port: WalletPort,
  store: KeyStore,
  passkeys: Passkeys,
): WalletEffects {
  const backups = loadFromServer(() => import("./backup")).pipe(
    Effect.map(({ deviceBackup }) => deviceBackup(port, passkeys, store)),
  );

  const sending = loadFromServer(() => import("./sending")).pipe(
    Effect.map(({ sendTransfer }) => sendTransfer(port, store)),
  );

  const links = loadFromServer(() => import("./payment-links")).pipe(
    Effect.map(({ devicePaymentLinks }) => devicePaymentLinks(port, store)),
  );

  const create = Effect.fn("Device.create")(function* (usernameText: string) {
    const username = Schema.decodeUnknownOption(Username)(usernameText);

    if (Option.isNone(username)) return new InvalidUsername();

    const { openWallet } = yield* loadFromServer(() => import("./opening"));

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
      Predicate.isTagged(overview, "Holding") &&
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
        Offline: (failure) => Effect.succeed(failure),
        ServerUnreachable: (failure) => Effect.succeed(failure),
        LedgerUnreachable: (failure) => Effect.succeed(failure),
        ServiceFailed: (failure) => Effect.succeed(failure),
        InvalidResponse: (failure) => Effect.succeed(failure),
        PasskeyCancelled: (cancelled) => Effect.succeed(cancelled),
        PasskeyFailed: (failed) => Effect.succeed(failed),
      }),
    );

  const transfer = <A>(
    program: Effect.Effect<A, KeyStoreUnavailable | WalletUnavailable>,
  ) =>
    program.pipe(
      Effect.catchTags({
        KeyStoreUnavailable: () => Effect.succeed(new UnsupportedDevice()),
        Offline: (failure) => Effect.succeed(failure),
        ServerUnreachable: (failure) => Effect.succeed(failure),
        LedgerUnreachable: (failure) => Effect.succeed(failure),
        ServiceFailed: (failure) => Effect.succeed(failure),
        InvalidResponse: (failure) => Effect.succeed(failure),
      }),
    );

  return {
    saved: () =>
      saved().pipe(
        Effect.catchTag("KeyStoreUnavailable", () =>
          Effect.succeed(new UnsupportedDevice()),
        ),
      ),
    overview: () =>
      overview().pipe(
        Effect.catchTags({
          KeyStoreUnavailable: () => Effect.succeed(new UnsupportedDevice()),
          Offline: (failure) => Effect.succeed(failure),
          ServerUnreachable: (failure) => Effect.succeed(failure),
          LedgerUnreachable: (failure) => Effect.succeed(failure),
          ServiceFailed: (failure) => Effect.succeed(failure),
          InvalidResponse: (failure) => Effect.succeed(failure),
        }),
      ),
    create: (usernameText) => settle(create(usernameText)),
    backUp: () => settle(backUp()),
    restore: () => settle(restore()),
    send: (intent) =>
      transfer(sending.pipe(Effect.flatMap(({ send }) => send(intent)))),
    review: (intent) =>
      transfer(sending.pipe(Effect.flatMap(({ review }) => review(intent)))),
    confirm: (shown) =>
      transfer(sending.pipe(Effect.flatMap(({ confirm }) => confirm(shown)))),
    resume: (id) =>
      transfer(sending.pipe(Effect.flatMap(({ resume }) => resume(id)))),
    createPaymentLink: (intent) =>
      transfer(
        links.pipe(
          Effect.flatMap(({ createPaymentLink }) => createPaymentLink(intent)),
        ),
      ),
    paymentLinks: () =>
      transfer(
        links.pipe(Effect.flatMap(({ paymentLinks }) => paymentLinks())),
      ),
    resolvePaymentLink: () =>
      transfer(
        links.pipe(
          Effect.flatMap(({ resolvePaymentLink }) => resolvePaymentLink()),
        ),
      ),
    cancelPaymentLink: (target) =>
      transfer(
        links.pipe(
          Effect.flatMap(({ cancelPaymentLink }) => cancelPaymentLink(target)),
        ),
      ),
  };
}

export function makeWalletClient(
  port: WalletPort,
  store: KeyStore,
  passkeys: Passkeys,
): WalletClient {
  const effects = makeWalletEffects(port, store, passkeys);

  return {
    overview: () => Effect.runPromise(effects.overview()),
    saved: () => Effect.runPromise(effects.saved()),
    create: (usernameText) => Effect.runPromise(effects.create(usernameText)),
    backUp: () => Effect.runPromise(effects.backUp()),
    restore: () => Effect.runPromise(effects.restore()),
    send: (intent) => Effect.runPromise(effects.send(intent)),
    review: (intent) => Effect.runPromise(effects.review(intent)),
    confirm: (shown) => Effect.runPromise(effects.confirm(shown)),
    resume: (id) => Effect.runPromise(effects.resume(id)),
    createPaymentLink: (intent) =>
      Effect.runPromise(effects.createPaymentLink(intent)),
    paymentLinks: () => Effect.runPromise(effects.paymentLinks()),
    resolvePaymentLink: () => Effect.runPromise(effects.resolvePaymentLink()),
    cancelPaymentLink: (target) =>
      Effect.runPromise(effects.cancelPaymentLink(target)),
  };
}
