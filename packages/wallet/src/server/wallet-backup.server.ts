import {
  type AuthenticationJSON,
  type RegistrationJSON,
  server,
} from "@passwordless-id/webauthn";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type Approvals,
  AssertionRefused,
  BackupEnrollment,
  BackupFound,
  ChallengeIssued,
  type ChallengePurpose,
  ChallengeRefused,
  type EnrollStep,
  type EnrollmentChallengeStep,
  type HumanCheckToken,
  NoBackup,
  PasskeyAssertion,
  PasskeyChallenge,
  RegistrationRefused,
  SealedPhrase,
  WalletClaim,
} from "../contract";
import { Backups, type StoredBackup } from "./Backups.server";
import type { ChainUnreachable } from "./Chain.server";
import { Directory, type StoreFailure } from "./Directory.server";
import { HumanCheck, type HumanCheckUnavailable } from "./HumanCheck.server";
import { openingFlow } from "./wallet-opening.server";
import { WalletSettings } from "./settings.server";
import { unavailability } from "./username-standing.server";

const ClientData = Schema.fromJsonString(
  Schema.Struct({ challenge: Schema.String }),
);

const clientChallenge = (clientDataJSON: string) =>
  Schema.decodeUnknownOption(Schema.StringFromBase64Url)(clientDataJSON).pipe(
    Option.flatMap(Schema.decodeUnknownOption(ClientData)),
    Option.flatMap((data) =>
      Schema.decodeUnknownOption(PasskeyChallenge)(data.challenge),
    ),
  );

const verifiableAlgorithm = Schema.Literals(["ES256", "RS256"]);

export const backupFlow = Effect.gen(function* () {
  const { openWith } = yield* openingFlow;
  const backups = yield* Backups;
  const directory = yield* Directory;
  const humanCheck = yield* HumanCheck;
  const settings = yield* WalletSettings;

  const allowedOrigin = (origin: string) =>
    settings.passkeyOrigins.includes(origin);

  const redeem = Effect.fn("Wallet.redeemChallenge")(function* (
    clientDataJSON: string,
    purpose: ChallengePurpose,
  ) {
    const challenge = clientChallenge(clientDataJSON);

    if (Option.isNone(challenge)) return Option.none<PasskeyChallenge>();

    return (yield* backups.consume(challenge.value, purpose))
      ? challenge
      : Option.none<PasskeyChallenge>();
  });

  const verifyEnrollment = (
    enrollment: BackupEnrollment,
    expectedChallenge: PasskeyChallenge,
  ) => {
    const { registration } = enrollment;

    const registrationJson: RegistrationJSON = {
      id: registration.id,
      rawId: registration.id,
      type: "public-key",
      clientExtensionResults: {},
      user: { name: `@${enrollment.username}` },
      response: {
        clientDataJSON: registration.clientDataJSON,
        authenticatorData: registration.authenticatorData,
        attestationObject: registration.attestationObject,
        publicKey: registration.publicKey,
        publicKeyAlgorithm: registration.publicKeyAlgorithm,
        transports: [...registration.transports],
      },
    };

    return Effect.tryPromise(() =>
      server.verifyRegistration(registrationJson, {
        challenge: expectedChallenge,
        origin: allowedOrigin,
        userVerified: true,
      }),
    ).pipe(
      Effect.option,
      Effect.map(
        Option.flatMap((verified) =>
          Schema.decodeUnknownOption(verifiableAlgorithm)(
            verified.credential.algorithm,
          ).pipe(
            Option.map((algorithm) => ({
              publicKey: verified.credential.publicKey,
              algorithm,
              counter: verified.authenticator.counter,
            })),
          ),
        ),
      ),
    );
  };

  const matchesCommittedBackup = (
    existing: StoredBackup,
    enrollment: BackupEnrollment,
    publicKey: string,
    algorithm: StoredBackup["algorithm"],
    submittedSealed: typeof SealedPhrase.Encoded,
  ) => {
    const storedSealed = Schema.encodeSync(SealedPhrase)(existing.sealed);

    return (
      existing.profile.address === enrollment.address &&
      existing.profile.username === enrollment.username &&
      existing.publicKey === publicKey &&
      existing.algorithm === algorithm &&
      storedSealed.iv === submittedSealed.iv &&
      storedSealed.ciphertext === submittedSealed.ciphertext
    );
  };

  const enrollmentChallenge = Effect.fn("Wallet.enrollmentChallenge")(
    function* (
      claim: WalletClaim,
      token: Option.Option<HumanCheckToken>,
    ): Effect.fn.Return<
      EnrollmentChallengeStep,
      StoreFailure | HumanCheckUnavailable
    > {
      const refused = unavailability(yield* directory.available(claim));

      if (Option.isSome(refused)) return refused.value;

      const verdict = yield* humanCheck.verify(token);

      if (Option.isSome(verdict)) return verdict.value;

      return new ChallengeIssued({
        challenge: yield* backups.issue("enrollment"),
      });
    },
  );

  const enroll = Effect.fn("Wallet.enroll")(function* (
    enrollment: BackupEnrollment,
    approvals: Approvals,
  ): Effect.fn.Return<EnrollStep, StoreFailure | ChainUnreachable> {
    const { registration } = enrollment;
    const parsedChallenge = clientChallenge(registration.clientDataJSON);

    if (Option.isNone(parsedChallenge)) return new ChallengeRefused();

    const challenge = parsedChallenge.value;
    const verified = yield* verifyEnrollment(enrollment, challenge);

    if (Option.isNone(verified))
      return (yield* backups.consume(challenge, "enrollment"))
        ? new RegistrationRefused()
        : new ChallengeRefused();

    const { publicKey, algorithm, counter } = verified.value;
    const sealed = Schema.encodeSync(SealedPhrase)(enrollment.sealed);

    const claim = new WalletClaim({
      username: enrollment.username,
      address: enrollment.address,
    });

    const matches = (stored: StoredBackup) =>
      matchesCommittedBackup(stored, enrollment, publicKey, algorithm, sealed);

    const existing = yield* backups.byCredential(registration.id);

    if (Option.isSome(existing) && !matches(existing.value))
      return new ChallengeRefused();

    if (Option.isNone(existing) && (yield* directory.bound(claim)))
      return new ChallengeRefused();

    const step = yield* openWith(claim, Option.some(approvals), {
      check: Effect.succeed(Option.none()),
      alongside: (tx) =>
        backups.commitEnrollment(tx, challenge, {
          credentialId: registration.id,
          address: enrollment.address,
          username: enrollment.username,
          publicKey,
          algorithm,
          counter,
          iv: sealed.iv,
          ciphertext: sealed.ciphertext,
        }),
    });

    const committed = (opened: EnrollStep) =>
      Effect.map(
        Effect.all([
          directory.bound(claim),
          backups.byCredential(registration.id),
        ]),
        ([bound, stored]) =>
          bound && Option.exists(stored, matches)
            ? opened
            : new ChallengeRefused(),
      );

    return yield* Match.valueTags(step, {
      OpeningPending: committed,
      Opened: committed,
      HumanCheckRefused: () => Effect.succeed(new ChallengeRefused()),
      OpeningDraft: Effect.succeed,
      RecoveryDraft: Effect.succeed,
      UsernameTaken: Effect.succeed,
      AddressBound: Effect.succeed,
      InvalidAddress: Effect.succeed,
      NotSponsored: Effect.succeed,
    });
  });

  const restore = Effect.fn("Wallet.restore")(function* (
    assertion: PasskeyAssertion,
  ) {
    const challenge = yield* redeem(assertion.clientDataJSON, "restore");

    if (Option.isNone(challenge)) return new ChallengeRefused();

    const found = yield* backups.byCredential(assertion.id);

    if (Option.isNone(found)) return new NoBackup();

    const backup = found.value;

    const authenticationJson: AuthenticationJSON = {
      id: assertion.id,
      rawId: assertion.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: assertion.clientDataJSON,
        authenticatorData: assertion.authenticatorData,
        signature: assertion.signature,
      },
    };

    const verified = yield* Effect.tryPromise(() =>
      server.verifyAuthentication(
        authenticationJson,
        {
          id: backup.credentialId,
          publicKey: backup.publicKey,
          algorithm: backup.algorithm,
          transports: [],
        },
        {
          challenge: challenge.value,
          origin: allowedOrigin,
          userVerified: true,
          counter: backup.counter,
        },
      ),
    ).pipe(Effect.option);

    if (Option.isNone(verified)) return new AssertionRefused();

    yield* backups.advance(backup.credentialId, verified.value.counter);

    return new BackupFound({
      profile: backup.profile,
      sealed: backup.sealed,
      publicKey: backup.publicKey,
      algorithm: backup.algorithm,
    });
  });

  return {
    restoreChallenge: () => backups.issue("restore"),
    enrollmentChallenge,
    enroll,
    restore,
  };
});
