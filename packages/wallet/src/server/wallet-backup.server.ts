import {
  type AuthenticationJSON,
  type RegistrationJSON,
  server,
} from "@passwordless-id/webauthn";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AssertionRefused,
  BackupEnrollment,
  BackupFound,
  BackupStored,
  ChallengeRefused,
  type ChallengePurpose,
  NoBackup,
  PasskeyAssertion,
  PasskeyChallenge,
  RegistrationRefused,
  SealedPhrase,
} from "../contract";
import { Backups } from "./Backups.server";
import { WalletSettings } from "./settings.server";

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
  const backups = yield* Backups;
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

  const confirmCommittedRetry = Effect.fn("Wallet.confirmCommittedBackup")(
    function* (enrollment: BackupEnrollment) {
      const parsedChallenge = clientChallenge(
        enrollment.registration.clientDataJSON,
      );

      if (Option.isNone(parsedChallenge)) return false;

      const existing = yield* backups.byCredential(enrollment.registration.id);

      if (Option.isNone(existing)) return false;

      const verified = yield* verifyEnrollment(
        enrollment,
        parsedChallenge.value,
      );

      if (Option.isNone(verified)) return false;

      const storedSealed = Schema.encodeSync(SealedPhrase)(
        existing.value.sealed,
      );

      const submittedSealed = Schema.encodeSync(SealedPhrase)(
        enrollment.sealed,
      );

      return (
        existing.value.profile.address === enrollment.address &&
        existing.value.profile.username === enrollment.username &&
        existing.value.publicKey === verified.value.publicKey &&
        existing.value.algorithm === verified.value.algorithm &&
        storedSealed.iv === submittedSealed.iv &&
        storedSealed.ciphertext === submittedSealed.ciphertext
      );
    },
  );

  const enroll = Effect.fn("Wallet.enroll")(function* (
    enrollment: BackupEnrollment,
  ) {
    const { registration } = enrollment;
    const challenge = yield* redeem(registration.clientDataJSON, "enrollment");

    if (Option.isNone(challenge))
      return (yield* confirmCommittedRetry(enrollment))
        ? new BackupStored()
        : new ChallengeRefused();

    const verified = yield* verifyEnrollment(enrollment, challenge.value);

    if (Option.isNone(verified)) return new RegistrationRefused();

    const sealed = Schema.encodeSync(SealedPhrase)(enrollment.sealed);

    const stored = yield* backups.enroll({
      credentialId: registration.id,
      address: enrollment.address,
      username: enrollment.username,
      publicKey: verified.value.publicKey,
      algorithm: verified.value.algorithm,
      counter: verified.value.counter,
      iv: sealed.iv,
      ciphertext: sealed.ciphertext,
    });

    return stored ? new BackupStored() : new RegistrationRefused();
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

    return new BackupFound({ profile: backup.profile, sealed: backup.sealed });
  });

  return {
    passkeyChallenge: (purpose: ChallengePurpose) => backups.issue(purpose),
    enroll,
    restore,
  };
});
