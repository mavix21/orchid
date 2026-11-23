import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import {
  BackupStored,
  type TransferId,
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
  type SealedDevice,
} from "./key-store";
import {
  type BackUpOutcome,
  type ConfirmOpeningOutcome,
  type ConfirmOutcome,
  type ConfirmReclaimOutcome,
  type ConfirmPaymentLinkOutcome,
  type DeviceOverview,
  NoWallet,
  type PaymentLinkIntent,
  type PaymentLinkTarget,
  type PaymentLinksOutcome,
  type OpeningReview,
  type PaymentReview,
  type ReclaimReview,
  type ResolvePaymentLinkOutcome,
  type RevealPaymentLinkOutcome,
  type ReviewPaymentLinkOutcome,
  type SavedLinkTarget,
  type RestoreOutcome,
  type ResumeOutcome,
  type ReviewOpeningOutcome,
  type ReviewReclaimOutcome,
  type ReviewOutcome,
  type SavedOutcome,
  SavedWallet,
  type TransferIntent,
  type UnlockOutcome,
  Unlocked,
  UnsupportedDevice,
} from "./outcomes";
import type { PasskeyCancelled, PasskeyFailed, Passkeys } from "./passkeys";
import type { HeldLink } from "./payment-links";
import { loadFromServer } from "./reaching";
import type { ReclaimIssue } from "./reclaim";
import type { RestoreProgress } from "./restore";

export * from "./outcomes";

export * from "./passkeys";

export { loadFromServer, unreachedServer } from "./reaching";

export interface WalletClient {
  overview(): Promise<DeviceOverview>;
  saved(): Promise<SavedOutcome>;
  unlock(): Promise<UnlockOutcome>;
  reviewOpening(usernameText: string): Promise<ReviewOpeningOutcome>;
  confirmOpening(review: OpeningReview): Promise<ConfirmOpeningOutcome>;
  backUp(): Promise<BackUpOutcome>;
  restore(): Promise<RestoreOutcome>;
  cancelRestore(): Promise<void>;
  review(intent: TransferIntent): Promise<ReviewOutcome>;
  confirm(review: PaymentReview): Promise<ConfirmOutcome>;
  resume(id: TransferId): Promise<ResumeOutcome>;
  reviewPaymentLink(
    intent: PaymentLinkIntent,
  ): Promise<ReviewPaymentLinkOutcome>;
  confirmPaymentLink(review: PaymentReview): Promise<ConfirmPaymentLinkOutcome>;
  paymentLinks(): Promise<PaymentLinksOutcome>;
  resolvePaymentLink(): Promise<ResolvePaymentLinkOutcome>;
  revealPaymentLink(target: SavedLinkTarget): Promise<RevealPaymentLinkOutcome>;
  reviewReclaim(target: PaymentLinkTarget): Promise<ReviewReclaimOutcome>;
  confirmReclaim(review: ReclaimReview): Promise<ConfirmReclaimOutcome>;
}

export interface WalletEffects {
  overview(): Effect.Effect<DeviceOverview>;
  saved(): Effect.Effect<SavedOutcome>;
  unlock(): Effect.Effect<UnlockOutcome>;
  reviewOpening(usernameText: string): Effect.Effect<ReviewOpeningOutcome>;
  confirmOpening(review: OpeningReview): Effect.Effect<ConfirmOpeningOutcome>;
  backUp(): Effect.Effect<BackUpOutcome>;
  restore(): Effect.Effect<RestoreOutcome>;
  cancelRestore(): Effect.Effect<void>;
  review(intent: TransferIntent): Effect.Effect<ReviewOutcome>;
  confirm(review: PaymentReview): Effect.Effect<ConfirmOutcome>;
  resume(id: TransferId): Effect.Effect<ResumeOutcome>;
  reviewPaymentLink(
    intent: PaymentLinkIntent,
  ): Effect.Effect<ReviewPaymentLinkOutcome>;
  confirmPaymentLink(
    review: PaymentReview,
  ): Effect.Effect<ConfirmPaymentLinkOutcome>;
  paymentLinks(): Effect.Effect<PaymentLinksOutcome>;
  resolvePaymentLink(): Effect.Effect<ResolvePaymentLinkOutcome>;
  revealPaymentLink(
    target: SavedLinkTarget,
  ): Effect.Effect<RevealPaymentLinkOutcome>;
  reviewReclaim(target: PaymentLinkTarget): Effect.Effect<ReviewReclaimOutcome>;
  confirmReclaim(review: ReclaimReview): Effect.Effect<ConfirmReclaimOutcome>;
}

export function makeWalletEffects(
  port: WalletPort,
  store: KeyStore,
  passkeys: Passkeys,
  device?: SealedDevice,
): WalletEffects {
  const restoreProgress: RestoreProgress = {
    pending: Ref.makeUnsafe(Option.none()),
    lock: Semaphore.makeUnsafe(1),
  };

  const issuedReview = Ref.makeUnsafe(Option.none<string>());
  const heldLink = Ref.makeUnsafe(Option.none<HeldLink>());
  const issuedOpening = Ref.makeUnsafe(Option.none<string>());

  const reclaimIssue = Ref.makeUnsafe<ReclaimIssue>({
    ticket: 0,
    issued: Option.none(),
  });

  const sending = loadFromServer(() => import("./sending")).pipe(
    Effect.map(({ sendTransfer }) =>
      sendTransfer(port, store, { issued: issuedReview, device }),
    ),
  );

  const links = loadFromServer(() => import("./payment-links")).pipe(
    Effect.map(({ devicePaymentLinks }) =>
      devicePaymentLinks(
        port,
        store,
        { issued: issuedReview, device },
        heldLink,
      ),
    ),
  );

  const reclaim = loadFromServer(() => import("./reclaim")).pipe(
    Effect.map(({ deviceReclaim }) =>
      deviceReclaim(port, store, { state: reclaimIssue, device }),
    ),
  );

  const opening = loadFromServer(() => import("./opening")).pipe(
    Effect.map(({ deviceOpening }) =>
      deviceOpening(port, store, { issued: issuedOpening, device }),
    ),
  );

  const backUp = Effect.fn("Device.backUp")(function* () {
    const stored = yield* store.readPublic();

    if (Option.isNone(stored)) return new NoWallet();

    return stored.value.backup === "stored"
      ? new BackupStored()
      : new UnsupportedDevice();
  });

  const restore = Effect.fn("Device.restore")(function* () {
    if (device === undefined) return new UnsupportedDevice();

    const { deviceRestore } = yield* loadFromServer(() => import("./restore"));

    return yield* deviceRestore(
      port,
      passkeys,
      device,
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
    if (device === undefined) return new UnsupportedDevice();

    const sealed = yield* device.store.readSealed();

    if (Option.isNone(sealed)) return new NoWallet();

    const verified = yield* verifyPinnedAssertion(
      device.ceremony,
      device.relyingParty(),
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
    reviewOpening: (usernameText) =>
      settle(
        opening.pipe(Effect.flatMap(({ review }) => review(usernameText))),
      ),
    confirmOpening: (shown) =>
      settle(
        opening.pipe(
          Effect.flatMap(({ confirm }) => confirm(shown)),
          Effect.catchTag("CorruptDeviceWallet", (damaged) =>
            Effect.succeed(damaged),
          ),
        ),
      ),
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
    review: (intent) =>
      transfer(sending.pipe(Effect.flatMap(({ review }) => review(intent)))),
    confirm: (shown) =>
      transfer(
        sending.pipe(
          Effect.flatMap(({ confirm }) => confirm(shown)),
          Effect.catchTag("CorruptDeviceWallet", (damaged) =>
            Effect.succeed(damaged),
          ),
        ),
      ),
    resume: (id) =>
      transfer(sending.pipe(Effect.flatMap(({ resume }) => resume(id)))),
    reviewPaymentLink: (intent) =>
      transfer(links.pipe(Effect.flatMap(({ review }) => review(intent)))),
    confirmPaymentLink: (shown) =>
      transfer(
        links.pipe(
          Effect.flatMap(({ confirm }) => confirm(shown)),
          Effect.catchTag("CorruptDeviceWallet", (damaged) =>
            Effect.succeed(damaged),
          ),
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
    revealPaymentLink: (target) =>
      settle(
        links.pipe(
          Effect.flatMap(({ reveal }) => reveal(target)),
          Effect.catchTag("CorruptDeviceWallet", (damaged) =>
            Effect.succeed(damaged),
          ),
        ),
      ),
    reviewReclaim: (target) =>
      transfer(reclaim.pipe(Effect.flatMap(({ review }) => review(target)))),
    confirmReclaim: (shown) =>
      transfer(
        reclaim.pipe(
          Effect.flatMap(({ confirm }) => confirm(shown)),
          Effect.catchTag("CorruptDeviceWallet", (damaged) =>
            Effect.succeed(damaged),
          ),
        ),
      ),
  };
}

export function makeWalletClient(
  port: WalletPort,
  store: KeyStore,
  passkeys: Passkeys,
  device?: SealedDevice,
): WalletClient {
  const effects = makeWalletEffects(port, store, passkeys, device);

  return {
    overview: () => Effect.runPromise(effects.overview()),
    saved: () => Effect.runPromise(effects.saved()),
    unlock: () => Effect.runPromise(effects.unlock()),
    reviewOpening: (usernameText) =>
      Effect.runPromise(effects.reviewOpening(usernameText)),
    confirmOpening: (shown) => Effect.runPromise(effects.confirmOpening(shown)),
    backUp: () => Effect.runPromise(effects.backUp()),
    restore: () => Effect.runPromise(effects.restore()),
    cancelRestore: () => Effect.runPromise(effects.cancelRestore()),
    review: (intent) => Effect.runPromise(effects.review(intent)),
    confirm: (shown) => Effect.runPromise(effects.confirm(shown)),
    resume: (id) => Effect.runPromise(effects.resume(id)),
    reviewPaymentLink: (intent) =>
      Effect.runPromise(effects.reviewPaymentLink(intent)),
    confirmPaymentLink: (shown) =>
      Effect.runPromise(effects.confirmPaymentLink(shown)),
    paymentLinks: () => Effect.runPromise(effects.paymentLinks()),
    resolvePaymentLink: () => Effect.runPromise(effects.resolvePaymentLink()),
    revealPaymentLink: (target) =>
      Effect.runPromise(effects.revealPaymentLink(target)),
    reviewReclaim: (target) => Effect.runPromise(effects.reviewReclaim(target)),
    confirmReclaim: (shown) => Effect.runPromise(effects.confirmReclaim(shown)),
  };
}
