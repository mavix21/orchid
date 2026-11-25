import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  AccountAddress,
  BackupEnrollment,
  InvalidResponse,
  type OpenStep,
  RegistrationRefused,
  Username,
  type UsernameTaken,
  type WalletUnavailable,
} from "../contract";
import { type LinkCode } from "./link-code";
import { network } from "../stellar/network";
import {
  AssertionIntent,
  AssertionRejected,
  verifyPinnedAssertion,
} from "./assertion";
import { type ReceiveSlot, enrollmentReceive } from "./enrollment-receive";
import {
  type EnrollWalletOutcome,
  type EnrollmentClient,
  type EnrollmentDependencies,
  type EnrollmentEffects,
  EnrollmentPending,
  type EnrollmentReceive,
  HeldReceive,
  PendingActivation,
  PendingCandidate,
  PendingRelease,
  type ReviewEnrollmentReceiveOutcome,
} from "./enrollment-records";
import {
  type Awaiting,
  type Created,
  type Held,
  PendingState,
  type Sealed,
  Verified,
  addressOf,
  claimOf,
  credentialOf,
  isCreated,
  isHeld,
  memoryPendingStorage,
  notice,
  pinCredential,
  saltOf,
  sameCandidate,
  standingOfReview,
  usernameOf,
  withReview,
  zeroed,
} from "./enrollment-state";
import {
  CorruptEnvelope,
  freshInstallationSalt,
  localPhrasePrfInput,
  openLocalEnvelope,
  sealLocalEnvelope,
} from "./local-envelope";
import { linkSecretFor, receiveReviewJson } from "./link-receive";
import { requestsOf, reviewJson } from "./opening-drafts";
import {
  BackupUnsupported,
  InvalidUsername,
  LinkSecretMismatch,
  NoWallet,
  OpeningReview,
  UnsupportedDevice,
  WalletOnDevice,
} from "./outcomes";
import { backupSalt, openPhrase, sealPhrase } from "./phrase-seal";
import { generateSecretPhrase } from "./secret-phrase";
import {
  approveWithLinkSecret,
  approveWithPhrase,
  signingKey,
} from "./signing";

import { enrollmentRelease } from "./enrollment-release";

export * from "./enrollment-records";

export function makeEnrollmentEffects(
  deps: EnrollmentDependencies,
): EnrollmentEffects {
  let state: PendingState = PendingState.Idle();
  const receiving: ReceiveSlot = { review: Option.none() };
  const lock = Semaphore.makeUnsafe(1);
  const storage = deps.pending ?? memoryPendingStorage();

  const clearPending = Effect.gen(function* () {
    state = PendingState.Idle();
    receiving.review = Option.none();

    yield* storage.clear();
  });

  const pendingNotice = (current: Awaiting | Held) =>
    notice(current, receiving.review);

  const release = enrollmentRelease(deps, clearPending);

  const loadPending = Effect.gen(function* () {
    if (!PendingState.$is("Idle")(state)) return state;

    const restored = yield* storage.read();

    if (Option.isNone(restored)) return state;

    if (Predicate.isTagged(restored.value, "PendingActivation")) {
      const { enrollment, candidate, review } = restored.value;

      state = PendingState.Sealed({
        enrollment,
        candidate,
        review: Option.some(review),
      });

      return state;
    }

    const { enrollment, candidate, review, approvals, receive } =
      restored.value;

    state = PendingState.Held({
      enrollment,
      candidate,
      review,
      approvals,
      receive,
    });

    return state;
  });

  const installedConflict = Effect.fn("Device.enrollmentInstalledConflict")(
    function* (
      current: PendingState,
    ): Effect.fn.Return<Option.Option<EnrollWalletOutcome>> {
      const installed = yield* deps.store.readSealed().pipe(Effect.result);

      if (Result.isFailure(installed))
        return Option.some<EnrollWalletOutcome>(
          Match.valueTags(installed.failure, {
            CorruptDeviceWallet: (corrupt) => corrupt,
            KeyStoreUnavailable: () => new UnsupportedDevice(),
          }),
        );

      if (Option.isNone(installed.success)) return Option.none();

      if (
        isHeld(current) &&
        sameCandidate(installed.success.value, current.candidate)
      )
        return Option.none();

      yield* clearPending;

      return Option.some<EnrollWalletOutcome>(new WalletOnDevice());
    },
  );

  const requestReview = Effect.fn("Device.requestEnrollmentReview")(function* (
    current: Awaiting,
    redrafted: boolean,
  ): Effect.fn.Return<
    OpeningReview | UsernameTaken | InvalidResponse,
    WalletUnavailable
  > {
    const step: OpenStep = yield* deps.port.open(
      claimOf(current),
      Option.none(),
    );

    const unexpected = () => Effect.succeed(new InvalidResponse());

    return yield* Match.valueTags(step, {
      OpeningDraft: (draft) => {
        if (draft.recovery === undefined) return unexpected();

        const review = new OpeningReview({
          username: usernameOf(current),
          address: addressOf(current),
          draft,
          redrafted,
        });

        return Effect.map(standingOfReview(current, review), (standing) =>
          standing === "current" ? review : new InvalidResponse(),
        );
      },
      UsernameTaken: Effect.succeed,
      HumanCheckRefused: unexpected,
      RecoveryDraft: unexpected,
      OpeningPending: unexpected,
      Opened: unexpected,
      AddressBound: unexpected,
      InvalidAddress: unexpected,
      NotSponsored: unexpected,
    });
  });

  const refreshReview = Effect.fn("Device.refreshEnrollmentReview")(function* (
    current: Awaiting,
    redrafted: boolean,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    const requested = yield* requestReview(current, redrafted).pipe(
      Effect.result,
    );

    if (Result.isFailure(requested)) return requested.failure;

    if (requested.success instanceof OpeningReview) {
      const next = withReview(current, Option.some(requested.success));

      state = next;

      return pendingNotice(next);
    }

    if (Predicate.isTagged(requested.success, "UsernameTaken"))
      yield* clearPending;

    return requested.success;
  });

  const hasLiveReview = Effect.fn("Device.enrollmentHasLiveReview")(function* (
    current: Awaiting,
  ) {
    if (Option.isNone(current.review)) return false;

    return (
      (yield* standingOfReview(current, current.review.value)) === "current"
    );
  });

  const { receiveStanding, refreshReceive, reviewOpenLink } = enrollmentReceive(
    deps.port,
    receiving,
    pendingNotice,
  );

  const sealCandidate = Effect.fn("Device.sealEnrollmentCandidate")(function* (
    current: Created,
    review: OpeningReview,
    devicePrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
    backupPrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
  ): Effect.fn.Return<Sealed | EnrollWalletOutcome> {
    const sealedBackup = yield* sealPhrase(
      Redacted.value(backupPrf),
      Redacted.value(current.phrase),
    );

    const sealedLocal = yield* sealLocalEnvelope(
      {
        phrase: Redacted.value(current.phrase),
        network,
        address: current.address,
        credentialId: current.credential.id,
        salt: current.salt,
      },
      devicePrf,
    );

    if (sealedLocal instanceof CorruptEnvelope)
      return yield* clearPending.pipe(Effect.as(sealedLocal));

    const candidate = new PendingCandidate({
      username: current.username,
      address: current.address,
      credential: current.credential,
      envelope: sealedLocal.envelope,
    });

    const enrollment = new BackupEnrollment({
      address: current.address,
      username: current.username,
      registration: current.registration,
      sealed: sealedBackup,
    });

    const written = yield* storage
      .write(new PendingActivation({ enrollment, candidate, review }))
      .pipe(Effect.result);

    if (Result.isFailure(written))
      return yield* clearPending.pipe(Effect.as(new UnsupportedDevice()));

    const next = PendingState.Sealed({
      enrollment,
      candidate,
      review: Option.some(review),
    });

    state = next;

    return next;
  });

  const verifyCandidate = Effect.fn("Device.verifyEnrollmentCandidate")(
    function* (
      devicePrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
      backupPrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
    ): Effect.fn.Return<Verified | EnrollWalletOutcome> {
      const persisted = yield* storage.read();

      if (
        Option.isNone(persisted) ||
        !Predicate.isTagged(persisted.value, "PendingActivation")
      )
        return yield* clearPending.pipe(Effect.as(new NoWallet()));

      const { enrollment, candidate } = persisted.value;

      const local = yield* openLocalEnvelope(
        candidate.envelope,
        {
          network,
          address: candidate.address,
          credentialId: candidate.credential.id,
        },
        devicePrf,
      );

      const backup = yield* openPhrase(
        Redacted.value(backupPrf),
        enrollment.sealed,
      );

      if (
        local instanceof CorruptEnvelope ||
        Option.isNone(backup) ||
        backup.value !== Redacted.value(local.phrase) ||
        signingKey(backup.value).publicKey() !== candidate.address
      )
        return yield* clearPending.pipe(Effect.as(new CorruptEnvelope()));

      return new Verified({
        enrollment,
        candidate,
        phrase: backup.value,
      });
    },
  );

  const sealAndSign = Effect.fn("Device.sealAndSignEnrollment")(function* (
    current: Awaiting,
    review: OpeningReview,
    devicePrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
    backupPrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
    receive: EnrollmentReceive | undefined,
  ): Effect.fn.Return<Held | EnrollWalletOutcome> {
    const sealed = isCreated(current)
      ? yield* sealCandidate(current, review, devicePrf, backupPrf)
      : current;

    if (!Predicate.isTagged(sealed, "Sealed")) return sealed;

    const verified = yield* verifyCandidate(devicePrf, backupPrf);

    if (!(verified instanceof Verified)) return verified;

    if ((yield* standingOfReview(sealed, review)) !== "current")
      return yield* refreshReview(sealed, true);

    const secret =
      receive === undefined
        ? Option.none()
        : linkSecretFor(receive.review.link, receive.code);

    if (receive !== undefined) {
      if (Option.isNone(secret)) return new LinkSecretMismatch();

      if ((yield* receiveStanding(sealed, receive.review)) !== "current")
        return yield* refreshReceive(sealed, receive.review);
    }

    const approvals = approveWithPhrase(
      verified.phrase,
      requestsOf(review.draft),
    );

    const heldReceive =
      receive !== undefined && Option.isSome(secret)
        ? new HeldReceive({
            order: receive.review.order,
            approval: approveWithLinkSecret(secret.value, [
              receive.review.draft.request,
            ])[0],
          })
        : undefined;

    const written = yield* storage
      .write(
        new PendingRelease({
          enrollment: verified.enrollment,
          candidate: verified.candidate,
          review,
          approvals,
          receive: heldReceive,
        }),
      )
      .pipe(Effect.result);

    if (Result.isFailure(written))
      return yield* clearPending.pipe(Effect.as(new UnsupportedDevice()));

    const held = PendingState.Held({
      enrollment: verified.enrollment,
      candidate: verified.candidate,
      review,
      approvals,
      receive: heldReceive,
    });

    state = held;

    return held;
  });

  const activate = Effect.fn("Device.activateEnrollment")(function* (
    current: Awaiting,
    shown: OpeningReview | undefined,
    receive: EnrollmentReceive | undefined,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    if (Option.isNone(current.review) || !(yield* hasLiveReview(current)))
      return yield* refreshReview(current, false);

    const { review } = current;

    if (shown === undefined || reviewJson(shown) !== reviewJson(review.value))
      return pendingNotice(current);

    if (receive !== undefined) {
      if (
        !Option.exists(
          receiving.review,
          (held) =>
            receiveReviewJson(held) === receiveReviewJson(receive.review),
        )
      )
        return pendingNotice(current);

      if (Option.isNone(linkSecretFor(receive.review.link, receive.code)))
        return new LinkSecretMismatch();

      if ((yield* receiveStanding(current, receive.review)) !== "current")
        return yield* refreshReceive(current, receive.review);
    }

    const verified = yield* verifyPinnedAssertion(
      deps.assertions,
      deps.relyingParty,
      credentialOf(current),
      AssertionIntent.Operation({
        purpose: "approval",
        prf: {
          first: yield* localPhrasePrfInput({
            network,
            address: addressOf(current),
            salt: saltOf(current),
          }),
          second: Option.some(yield* backupSalt),
        },
      }),
    ).pipe(Effect.result);

    if (Result.isFailure(verified)) return verified.failure;

    return yield* Match.valueTags(verified.success, {
      OperationVerified: ({ prf }) =>
        Option.match(prf.second, {
          onNone: () =>
            clearPending.pipe(
              Effect.as<EnrollWalletOutcome>(new BackupUnsupported()),
              Effect.ensuring(zeroed(prf.first)),
            ),
          onSome: (backupPrf) =>
            sealAndSign(
              current,
              review.value,
              prf.first,
              backupPrf,
              receive,
            ).pipe(
              Effect.ensuring(
                Effect.all([zeroed(prf.first), zeroed(backupPrf)]),
              ),
              Effect.flatMap((signed) =>
                isHeld(signed) ? release(signed) : Effect.succeed(signed),
              ),
            ),
        }),
      EntryVerified: () => Effect.succeed(new AssertionRejected()),
      WrongCredential: Effect.succeed,
      AssertionRejected: Effect.succeed,
      PrfOutputMissing: () =>
        clearPending.pipe(Effect.as(new BackupUnsupported())),
    });
  });

  const start = Effect.fn("Device.startEnrollment")(function* (
    usernameText: string,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    const username = Schema.decodeUnknownOption(Username)(usernameText);

    if (Option.isNone(username)) return new InvalidUsername();

    const current = yield* loadPending;

    const blocked = yield* installedConflict(current);

    if (Option.isSome(blocked)) return blocked.value;

    if (!PendingState.$is("Idle")(current)) return pendingNotice(current);

    const phrase = generateSecretPhrase();

    const address = Schema.decodeSync(AccountAddress)(
      signingKey(phrase).publicKey(),
    );

    const challenge = yield* deps.port
      .passkeyChallenge("enrollment")
      .pipe(Effect.result);

    if (Result.isFailure(challenge)) return challenge.failure;

    const registered = yield* deps.registration
      .register({ challenge: challenge.success, username: username.value })
      .pipe(Effect.result);

    if (Result.isFailure(registered)) return registered.failure;

    if (Option.isNone(registered.success)) return new BackupUnsupported();

    const credential = pinCredential(registered.success.value);

    if (Option.isNone(credential)) return new RegistrationRefused();

    const created = PendingState.Created({
      username: username.value,
      address,
      phrase: Redacted.make(phrase),
      salt: freshInstallationSalt(),
      registration: registered.success.value,
      credential: credential.value,
      review: Option.none(),
    });

    state = created;

    return yield* refreshReview(created, false);
  });

  const advance = Effect.fn("Device.advanceEnrollment")(function* (
    shown: OpeningReview | undefined,
    receive: EnrollmentReceive | undefined,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    const current = yield* loadPending;

    const blocked = yield* installedConflict(current);

    if (Option.isSome(blocked)) return blocked.value;

    return yield* PendingState.$match(current, {
      Idle: () => Effect.succeed(new NoWallet()),
      Created: (awaiting) => activate(awaiting, shown, receive),
      Sealed: (awaiting) => activate(awaiting, shown, receive),
      Held: release,
    });
  });

  const pending = Effect.fn("Device.pendingEnrollment")(function* () {
    const current = yield* loadPending;

    const blocked = yield* installedConflict(current);

    if (Option.isSome(blocked) || PendingState.$is("Idle")(current))
      return Option.none<EnrollmentPending>();

    if (isHeld(current)) return Option.some(pendingNotice(current));

    if (yield* hasLiveReview(current))
      return Option.some(pendingNotice(current));

    const refreshed = yield* refreshReview(current, false);

    if (PendingState.$is("Idle")(state))
      return Option.none<EnrollmentPending>();

    return Option.some(
      Predicate.isTagged(refreshed, "EnrollmentPending")
        ? refreshed
        : pendingNotice(withReview(current, Option.none())),
    );
  });

  const reviewReceive = Effect.fn("Device.reviewEnrollmentReceive")(function* (
    code: LinkCode,
  ): Effect.fn.Return<ReviewEnrollmentReceiveOutcome> {
    const current = yield* loadPending;

    const blocked = yield* installedConflict(current);

    if (Option.isSome(blocked) || PendingState.$is("Idle")(current))
      return new NoWallet();

    if (isHeld(current)) return pendingNotice(current);

    return yield* reviewOpenLink(current, code);
  });

  return {
    pending: () => lock.withPermit(pending()),
    start: (usernameText) => lock.withPermit(start(usernameText)),
    advance: (shown, receive) => lock.withPermit(advance(shown, receive)),
    reviewReceive: (code) => lock.withPermit(reviewReceive(code)),
  };
}

export function makeEnrollmentClient(
  deps: EnrollmentDependencies,
): EnrollmentClient {
  const effects = makeEnrollmentEffects(deps);

  return {
    pending: () => Effect.runPromise(effects.pending()),
    start: (usernameText) => Effect.runPromise(effects.start(usernameText)),
    advance: (shown, receive) =>
      Effect.runPromise(effects.advance(shown, receive)),
    reviewReceive: (code) => Effect.runPromise(effects.reviewReceive(code)),
  };
}
