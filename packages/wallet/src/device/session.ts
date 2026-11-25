import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import {
  ChallengeIssued,
  type PasskeyChallenge,
  type WalletPort,
} from "../contract";
import {
  AssertionIntent,
  AssertionRejected,
  verifyPinnedAssertion,
} from "./assertion";
import type { SealedDevice } from "./key-store";
import {
  type ConfirmSessionOutcome,
  NoWallet,
  SessionConfirmed,
  Unlocked,
  UnsupportedDevice,
} from "./outcomes";

export function deviceSession(
  port: Pick<WalletPort, "sessionChallenge" | "beginSession">,
  device: SealedDevice | undefined,
) {
  const challenge = Effect.fn("Device.sessionChallenge")(function* () {
    return new ChallengeIssued({ challenge: yield* port.sessionChallenge() });
  });

  const confirm = Effect.fn("Device.confirmSession")(function* (
    issued: PasskeyChallenge,
  ) {
    if (device === undefined) return new UnsupportedDevice();

    const sealed = yield* device.store.readSealed();

    if (Option.isNone(sealed)) return new NoWallet();

    const verified = yield* verifyPinnedAssertion(
      device.ceremony,
      device.relyingParty(),
      sealed.value.credential,
      AssertionIntent.Entry(),
      issued,
    );

    return yield* Match.valueTags(verified, {
      EntryVerified: ({ assertion }) =>
        port.beginSession(assertion).pipe(
          Effect.map((step) =>
            Match.valueTags(step, {
              SessionBegun: () => new SessionConfirmed(),
              NoBackup: (refusal) => refusal,
              AssertionRefused: (refusal) => refusal,
              ChallengeRefused: (refusal) => refusal,
            }),
          ),
        ),
      OperationVerified: () => Effect.succeed(new AssertionRejected()),
      PrfOutputMissing: () => Effect.succeed(new AssertionRejected()),
      WrongCredential: Effect.succeed,
      AssertionRejected: Effect.succeed,
    });
  });

  const unlockWith = Effect.fn("Device.unlockWithSession")(function* (
    issued: PasskeyChallenge,
  ) {
    const confirmed: ConfirmSessionOutcome = yield* confirm(issued).pipe(
      Effect.catchTags({
        Offline: () => Effect.succeed(new SessionConfirmed()),
        ServerUnreachable: () => Effect.succeed(new SessionConfirmed()),
        LedgerUnreachable: () => Effect.succeed(new SessionConfirmed()),
        ServiceFailed: () => Effect.succeed(new SessionConfirmed()),
        SessionRequired: () => Effect.succeed(new SessionConfirmed()),
        InvalidResponse: () => Effect.succeed(new SessionConfirmed()),
      }),
    );

    return confirmed instanceof SessionConfirmed ? new Unlocked() : confirmed;
  });

  return { challenge, confirm, unlockWith };
}
