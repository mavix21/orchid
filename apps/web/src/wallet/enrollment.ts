import {
  type EnrollmentClient,
  type EnrollmentEffects,
  loadFromServer,
} from "@workspace/wallet";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const loaded = loadFromServer(() => import("./enrollment-client")).pipe(
  Effect.map((client) => client.enrollmentEffects),
);

const withEnrollment = <A>(
  use: (enrollment: EnrollmentEffects) => Effect.Effect<A>,
) =>
  loaded.pipe(
    Effect.flatMap(use),
    Effect.catch((failure) => Effect.succeed(failure)),
  );

export const enrollmentEffects: EnrollmentEffects = {
  pending: () =>
    loaded.pipe(
      Effect.flatMap((enrollment) => enrollment.pending()),
      Effect.orElseSucceed(() => Option.none()),
    ),
  start: (usernameText) =>
    withEnrollment((enrollment) => enrollment.start(usernameText)),
  advance: (displayedUntil) =>
    withEnrollment((enrollment) => enrollment.advance(displayedUntil)),
};

export const enrollmentClient: EnrollmentClient = {
  pending: () => Effect.runPromise(enrollmentEffects.pending()),
  start: (usernameText) =>
    Effect.runPromise(enrollmentEffects.start(usernameText)),
  advance: (displayedUntil) =>
    Effect.runPromise(enrollmentEffects.advance(displayedUntil)),
};
