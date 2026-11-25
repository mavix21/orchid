import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { network } from "../stellar/network";
import type {
  EnrollWalletOutcome,
  PendingEnrollmentStorage,
} from "./enrollment-records";
import { Verified } from "./enrollment-state";
import { CorruptEnvelope, openLocalEnvelope } from "./local-envelope";
import { NoWallet } from "./outcomes";
import { openPhrase } from "./phrase-seal";
import { signingKey } from "./signing";

export const candidateVerifier = (
  storage: PendingEnrollmentStorage,
  clearPending: Effect.Effect<void>,
) =>
  Effect.fn("Device.verifyEnrollmentCandidate")(function* (
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
  });
