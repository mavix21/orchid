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
  type OpenStep,
  RegistrationRefused,
  type UsernameTaken,
  Username,
  type WalletUnavailable,
  InvalidResponse,
} from "../contract";
import { network } from "../stellar/network";
import {
  AssertionIntent,
  AssertionRejected,
  verifyPinnedAssertion,
} from "./assertion";
import {
  type EnrollWalletOutcome,
  type EnrollmentClient,
  type EnrollmentDependencies,
  type EnrollmentEffects,
  EnrollmentPending,
  PendingActivation,
  PendingCandidate,
  PendingRelease,
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
  sameCredential,
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
import { requestsOf } from "./opening-drafts";
import {
  BackupUnsupported,
  DraftRejected,
  InvalidUsername,
  NoWallet,
  OpeningReview,
  UnsupportedDevice,
  WalletOnDevice,
} from "./outcomes";
import { PasskeyCancelled } from "./passkeys";
import { backupSalt, openPhrase, sealPhrase } from "./phrase-seal";
import { generateSecretPhrase } from "./secret-phrase";
import { approveWithPhrase, signingKey } from "./signing";

import { enrollmentRelease } from "./enrollment-release";

export * from "./enrollment-records";

export function makeEnrollmentEffects(
  deps: EnrollmentDependencies,
): EnrollmentEffects {
  let state: PendingState = PendingState.Idle();
  const lock = Semaphore.makeUnsafe(1);
  const storage = deps.pending ?? memoryPendingStorage();
  let epoch = 0;

  const clearPending = Effect.gen(function* () {
    state = PendingState.Idle();

    yield* storage.clear();
  });

  const release = enrollmentRelease(deps, clearPending);

  const loadPending = Effect.gen(function* () {
    if (!PendingState.$is("Idle")(state)) return state;

    const restored = yield* storage.read();

    if (Option.isSome(restored))
      state = Match.valueTags(restored.value, {
        PendingActivation: ({ enrollment, candidate, review }) =>
          PendingState.Sealed({
            enrollment,
            candidate,
            review: Option.some(review),
          }),
        PendingRelease: ({ enrollment, candidate, review, approvals }) =>
          PendingState.Held({ enrollment, candidate, review, approvals }),
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
    const consumed =
      redrafted ||
      (Option.isSome(current.review) && current.review.value.redrafted);

    const requested = yield* requestReview(current, consumed).pipe(
      Effect.result,
    );

    if (Result.isFailure(requested)) return requested.failure;

    if (requested.success instanceof OpeningReview) {
      const next = withReview(current, Option.some(requested.success));

      state = next;

      if (PendingState.$is("Sealed")(next))
        yield* storage
          .write(
            new PendingActivation({
              enrollment: next.enrollment,
              candidate: next.candidate,
              review: requested.success,
            }),
          )
          .pipe(Effect.ignore);

      return notice(next);
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
      expected: Sealed,
      devicePrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
      backupPrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
    ): Effect.fn.Return<Verified | EnrollWalletOutcome> {
      const persisted = yield* storage.read();

      if (
        Option.isNone(persisted) ||
        !Predicate.isTagged(persisted.value, "PendingActivation")
      )
        return new NoWallet();

      const { enrollment, candidate } = persisted.value;

      if (
        candidate.address !== expected.candidate.address ||
        candidate.username !== expected.candidate.username ||
        enrollment.address !== candidate.address ||
        enrollment.username !== candidate.username ||
        !sameCredential(candidate.credential, expected.candidate.credential) ||
        enrollment.registration.id !== candidate.credential.id ||
        enrollment.registration.publicKey !== candidate.credential.publicKey
      )
        return yield* clearPending.pipe(Effect.as(new CorruptEnvelope()));

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
    stillCurrent: () => boolean,
    devicePrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
    backupPrf: Redacted.Redacted<Uint8Array<ArrayBuffer>>,
  ): Effect.fn.Return<Held | EnrollWalletOutcome> {
    const sealed = isCreated(current)
      ? yield* sealCandidate(current, review, devicePrf, backupPrf)
      : current;

    if (!Predicate.isTagged(sealed, "Sealed")) return sealed;

    const verified = yield* verifyCandidate(sealed, devicePrf, backupPrf);

    if (!(verified instanceof Verified)) return verified;

    if ((yield* standingOfReview(sealed, review)) !== "current") {
      if (review.redrafted)
        return yield* clearPending.pipe(Effect.as(new DraftRejected()));

      return yield* refreshReview(sealed, true);
    }

    if (!stillCurrent()) return new PasskeyCancelled();

    const approvals = approveWithPhrase(
      verified.phrase,
      requestsOf(review.draft),
    );

    const written = yield* storage
      .write(
        new PendingRelease({
          enrollment: verified.enrollment,
          candidate: verified.candidate,
          review,
          approvals,
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
    });

    state = held;

    return held;
  });

  const activate = Effect.fn("Device.activateEnrollment")(function* (
    current: Awaiting,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    if (Option.isNone(current.review) || !(yield* hasLiveReview(current)))
      return yield* refreshReview(current, false);

    const { review } = current;
    const initiated = epoch;

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
            ),
          onSome: (backupPrf) =>
            (epoch === initiated
              ? sealAndSign(
                  current,
                  review.value,
                  () => epoch === initiated,
                  prf.first,
                  backupPrf,
                )
              : Effect.succeed<Held | EnrollWalletOutcome>(
                  new PasskeyCancelled(),
                )
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

    if (!PendingState.$is("Idle")(current)) return notice(current);

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

  const advance = Effect.fn("Device.advanceEnrollment")(
    function* (): Effect.fn.Return<EnrollWalletOutcome> {
      const current = yield* loadPending;

      const blocked = yield* installedConflict(current);

      if (Option.isSome(blocked)) return blocked.value;

      return yield* PendingState.$match(current, {
        Idle: () => Effect.succeed(new NoWallet()),
        Created: activate,
        Sealed: activate,
        Held: release,
      });
    },
  );

  const pending = Effect.fn("Device.pendingEnrollment")(function* () {
    const current = yield* loadPending;

    const blocked = yield* installedConflict(current);

    if (Option.isSome(blocked) || PendingState.$is("Idle")(current))
      return Option.none<EnrollmentPending>();

    if (isHeld(current)) return Option.some(notice(current));

    if (yield* hasLiveReview(current)) return Option.some(notice(current));

    const refreshed = yield* refreshReview(current, false);

    if (PendingState.$is("Idle")(state))
      return Option.none<EnrollmentPending>();

    return Option.some(
      Predicate.isTagged(refreshed, "EnrollmentPending")
        ? refreshed
        : notice(withReview(current, Option.none())),
    );
  });

  return {
    pending: () => lock.withPermit(pending()),
    start: (usernameText) => lock.withPermit(start(usernameText)),
    advance: () => lock.withPermit(advance()),
    retire: () =>
      Effect.sync(() => {
        epoch += 1;
      }),
  };
}

export function makeEnrollmentClient(
  deps: EnrollmentDependencies,
): EnrollmentClient {
  const effects = makeEnrollmentEffects(deps);

  return {
    pending: () => Effect.runPromise(effects.pending()),
    start: (usernameText) => Effect.runPromise(effects.start(usernameText)),
    advance: () => Effect.runPromise(effects.advance()),
    retire: () => Effect.runPromise(effects.retire()),
  };
}
