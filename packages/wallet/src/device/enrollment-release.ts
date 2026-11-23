import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { type OpenStep, OpeningPending, type WalletClaim } from "../contract";
import {
  type EnrollWalletOutcome,
  type EnrollmentDependencies,
  WalletEnrolled,
} from "./enrollment-records";
import {
  type Held,
  claimOf,
  isRetryableUnavailable,
  sameCandidate,
  standingOfReview,
} from "./enrollment-state";
import { PublicDeviceWallet, SealedDeviceWallet } from "./key-store";
import { localEnvelopeVersion } from "./local-envelope";
import { reserveSponsorOf } from "./opening-drafts";
import { DraftRejected, UnsupportedDevice, WalletOnDevice } from "./outcomes";
import { pollSchedule } from "./polling";

export const enrollmentRelease = (
  deps: EnrollmentDependencies,
  clearPending: Effect.Effect<void>,
) => {
  const awaitOpening = Effect.fn("Device.awaitEnrolledOpening")(function* (
    claim: WalletClaim,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    const settled = yield* Effect.repeat(deps.port.open(claim, Option.none()), {
      schedule: pollSchedule<OpenStep>(
        (step) => Predicate.isTagged(step, "OpeningPending"),
        () => true,
      ),
    }).pipe(Effect.result);

    if (Result.isFailure(settled)) return new OpeningPending();

    return Predicate.isTagged(settled.success, "Opened")
      ? new WalletEnrolled({ profile: settled.success.profile })
      : new OpeningPending();
  });

  const installCandidate = Effect.fn("Device.installEnrollmentCandidate")(
    function* (
      held: Held,
    ): Effect.fn.Return<Option.Option<EnrollWalletOutcome>> {
      const installed = yield* deps.store.readSealed().pipe(Effect.result);

      if (Result.isFailure(installed))
        return Option.some<EnrollWalletOutcome>(
          Match.valueTags(installed.failure, {
            CorruptDeviceWallet: (corrupt) => corrupt,
            KeyStoreUnavailable: () => new UnsupportedDevice(),
          }),
        );

      if (Option.isSome(installed.success))
        return sameCandidate(installed.success.value, held.candidate)
          ? Option.none()
          : yield* clearPending.pipe(
              Effect.as(Option.some<EnrollWalletOutcome>(new WalletOnDevice())),
            );

      const reserveSponsor = reserveSponsorOf(held.review.draft);

      if (Option.isNone(reserveSponsor))
        return yield* clearPending.pipe(
          Effect.as(Option.some<EnrollWalletOutcome>(new DraftRejected())),
        );

      const record = new SealedDeviceWallet({
        version: localEnvelopeVersion,
        public: new PublicDeviceWallet({
          address: held.candidate.address,
          username: held.candidate.username,
          backup: "stored",
          reserveSponsor: reserveSponsor.value,
        }),
        credential: held.candidate.credential,
        envelope: held.candidate.envelope,
      });

      const written = yield* deps.store
        .installSealed(record)
        .pipe(Effect.result);

      if (Result.isFailure(written))
        return Option.some<EnrollWalletOutcome>(
          Match.valueTags(written.failure, {
            CorruptDeviceWallet: (corrupt) => corrupt,
            KeyStoreUnavailable: () => new UnsupportedDevice(),
          }),
        );

      return written.success
        ? Option.none()
        : yield* clearPending.pipe(
            Effect.as(Option.some<EnrollWalletOutcome>(new WalletOnDevice())),
          );
    },
  );

  const release = Effect.fn("Device.releaseEnrollment")(function* (
    held: Held,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    const installed = yield* deps.store.readSealed().pipe(Effect.option);

    const backupStored =
      Option.isSome(installed) &&
      Option.isSome(installed.value) &&
      sameCandidate(installed.value.value, held.candidate);

    if (!backupStored) {
      const enrolled = yield* deps.port
        .enroll(held.enrollment)
        .pipe(Effect.result);

      if (Result.isFailure(enrolled)) {
        if (!isRetryableUnavailable(enrolled.failure)) yield* clearPending;

        return enrolled.failure;
      }

      const refused = Match.valueTags(enrolled.success, {
        BackupStored: () => Option.none<EnrollWalletOutcome>(),
        ChallengeRefused: (outcome) =>
          Option.some<EnrollWalletOutcome>(outcome),
        RegistrationRefused: (outcome) =>
          Option.some<EnrollWalletOutcome>(outcome),
      });

      if (Option.isSome(refused))
        return yield* clearPending.pipe(Effect.as(refused.value));
    }

    const blocked = yield* installCandidate(held);

    if (Option.isSome(blocked)) return blocked.value;

    const claim = claimOf(held);

    if ((yield* standingOfReview(held, held.review)) !== "current")
      return yield* clearPending.pipe(Effect.as(new OpeningPending()));

    const released = yield* deps.port
      .open(claim, Option.some(held.approvals))
      .pipe(Effect.result);

    if (Result.isFailure(released)) return released.failure;

    yield* clearPending;

    return Predicate.isTagged(released.success, "Opened")
      ? new WalletEnrolled({ profile: released.success.profile })
      : Predicate.isTagged(released.success, "OpeningPending")
        ? yield* awaitOpening(claim)
        : new OpeningPending();
  });

  return release;
};
