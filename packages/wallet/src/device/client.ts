import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  BackupStored,
  type TransferId,
  Username,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import {
  AssertionIntent,
  AssertionRejected,
  verifyPinnedAssertion,
} from "./assertion";
import {
  type KeyStore,
  type KeyStoreUnavailable,
  PublicDeviceWallet,
} from "./key-store";
import {
  type BackUpOutcome,
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
  type UnlockOutcome,
  Unlocked,
  UnsupportedDevice,
} from "./outcomes";
import type { PasskeyCancelled, PasskeyFailed, Passkeys } from "./passkeys";
import { loadFromServer } from "./reaching";
import type { RestoreDevice, RestoreProgress } from "./restore";

export * from "./outcomes";

export * from "./passkeys";

export { loadFromServer, unreachedServer } from "./reaching";

export interface WalletClient {
  overview(): Promise<DeviceOverview>;
  saved(): Promise<SavedOutcome>;
  unlock(): Promise<UnlockOutcome>;
  create(usernameText: string): Promise<CreateOutcome>;
  backUp(): Promise<BackUpOutcome>;
  restore(): Promise<RestoreOutcome>;
  cancelRestore(): Promise<void>;
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
  unlock(): Effect.Effect<UnlockOutcome>;
  create(usernameText: string): Effect.Effect<CreateOutcome>;
  backUp(): Effect.Effect<BackUpOutcome>;
  restore(): Effect.Effect<RestoreOutcome>;
  cancelRestore(): Effect.Effect<void>;
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
  restoration?: RestoreDevice,
): WalletEffects {
  const restoreProgress: RestoreProgress = {
    pending: Ref.makeUnsafe(Option.none()),
    lock: Semaphore.makeUnsafe(1),
  };

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

    return yield* openWallet(port, store)(username.value);
  });

  const backUp = Effect.fn("Device.backUp")(function* () {
    const stored = yield* store.readPublic();

    if (Option.isNone(stored)) return new NoWallet();

    return stored.value.backup === "stored"
      ? new BackupStored()
      : new UnsupportedDevice();
  });

  const restore = Effect.fn("Device.restore")(function* () {
    if (restoration === undefined) return new UnsupportedDevice();

    const { deviceRestore } = yield* loadFromServer(() => import("./restore"));

    return yield* deviceRestore(
      port,
      passkeys,
      restoration,
      restoreProgress,
    ).restore();
  });

  const serializedRestore = () =>
    restoreProgress.lock.withPermits(1)(restore());

  const overview = Effect.fn("Device.overview")(function* () {
    const stored = yield* store.readPublic();

    if (Option.isNone(stored)) return new NoWallet();

    const overview = yield* port.overview(stored.value.address);

    if (
      Predicate.isTagged(overview, "Holding") ||
      Predicate.isTagged(overview, "NeedsReopening")
    )
      yield* store.updatePublic((current) => {
        if (current.address !== stored.value.address) return Option.none();

        const reserveSponsor =
          Predicate.isTagged(overview, "Holding") &&
          Option.isSome(overview.reserveSponsor) &&
          current.reserveSponsor === undefined
            ? overview.reserveSponsor.value
            : current.reserveSponsor;

        const username =
          overview.profile.address === current.address
            ? overview.profile.username
            : current.username;

        return reserveSponsor === current.reserveSponsor &&
          username === current.username
          ? Option.none()
          : Option.some(
              new PublicDeviceWallet({
                ...current,
                username,
                reserveSponsor,
              }),
            );
      });

    return overview;
  });

  const saved = Effect.fn("Device.saved")(function* () {
    const stored = yield* store.readPublic();

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

  const unlock = Effect.fn("Device.unlock")(function* () {
    if (restoration === undefined) return new UnsupportedDevice();

    const sealed = yield* restoration.store.readSealed();

    if (Option.isNone(sealed)) return new NoWallet();

    const verified = yield* verifyPinnedAssertion(
      restoration.ceremony,
      restoration.relyingParty(),
      sealed.value.credential,
      AssertionIntent.Entry(),
    );

    return Match.valueTags(verified, {
      EntryVerified: () => new Unlocked(),
      OperationVerified: () => new AssertionRejected(),
      PrfOutputMissing: () => new AssertionRejected(),
      WrongCredential: (wrong) => wrong,
      AssertionRejected: (rejected) => rejected,
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
    unlock: () =>
      unlock().pipe(
        Effect.catchTags({
          KeyStoreUnavailable: () => Effect.succeed(new UnsupportedDevice()),
          CorruptDeviceWallet: (damaged) => Effect.succeed(damaged),
          PasskeyCancelled: (cancelled) => Effect.succeed(cancelled),
          PasskeyFailed: (failed) => Effect.succeed(failed),
        }),
      ),
    create: (usernameText) => settle(create(usernameText)),
    backUp: () => settle(backUp()),
    restore: () =>
      settle(
        serializedRestore().pipe(
          Effect.catchTag("CorruptDeviceWallet", (damaged) =>
            Effect.succeed(damaged),
          ),
        ),
      ),
    cancelRestore: () =>
      restoreProgress.lock.withPermits(1)(
        Ref.set(restoreProgress.pending, Option.none()),
      ),
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
  restoration?: RestoreDevice,
): WalletClient {
  const effects = makeWalletEffects(port, store, passkeys, restoration);

  return {
    overview: () => Effect.runPromise(effects.overview()),
    saved: () => Effect.runPromise(effects.saved()),
    unlock: () => Effect.runPromise(effects.unlock()),
    create: (usernameText) => Effect.runPromise(effects.create(usernameText)),
    backUp: () => Effect.runPromise(effects.backUp()),
    restore: () => Effect.runPromise(effects.restore()),
    cancelRestore: () => Effect.runPromise(effects.cancelRestore()),
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
