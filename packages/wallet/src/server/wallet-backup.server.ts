import {
  type AuthenticationJSON,
  type RegistrationJSON,
  server,
} from "@passwordless-id/webauthn";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  BackupEnrollment,
  BackupFound,
  BackupStored,
  ChallengeRefused,
  type ChallengePurpose,
  NoBackup,
  PasskeyAssertion,
  Profile,
  RegistrationRefused,
  SealedPhrase,
  Username,
} from "../contract";
import { Backups } from "./Backups.server";
import { WalletSettings } from "./settings.server";

const ClientData = Schema.fromJsonString(
  Schema.Struct({ challenge: Schema.String }),
);

const clientChallenge = (clientDataJSON: string) =>
  Schema.decodeUnknownOption(Schema.StringFromBase64Url)(clientDataJSON).pipe(
    Option.flatMap(Schema.decodeUnknownOption(ClientData)),
    Option.map((data) => data.challenge),
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

    if (Option.isNone(challenge)) return Option.none<string>();

    return (yield* backups.consume(challenge.value, purpose))
      ? challenge
      : Option.none<string>();
  });

  const enroll = Effect.fn("Wallet.enroll")(function* (
    enrollment: BackupEnrollment,
  ) {
    const { registration } = enrollment;
    const challenge = yield* redeem(registration.clientDataJSON, "enrollment");

    if (Option.isNone(challenge)) return new ChallengeRefused();

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

    const verified = yield* Effect.tryPromise(() =>
      server.verifyRegistration(registrationJson, {
        challenge: challenge.value,
        origin: allowedOrigin,
        userVerified: true,
      }),
    ).pipe(Effect.option);

    if (Option.isNone(verified)) return new RegistrationRefused();

    const algorithm = Schema.decodeUnknownOption(verifiableAlgorithm)(
      verified.value.credential.algorithm,
    );

    if (Option.isNone(algorithm)) return new RegistrationRefused();

    const sealed = Schema.encodeSync(SealedPhrase)(enrollment.sealed);

    const stored = yield* backups.enroll({
      credentialId: verified.value.credential.id,
      address: enrollment.address,
      username: enrollment.username,
      publicKey: verified.value.credential.publicKey,
      algorithm: algorithm.value,
      counter: verified.value.authenticator.counter,
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

    const { backup, boundUsername } = found.value;

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

    if (Option.isNone(verified)) return new NoBackup();

    yield* backups.advance(backup.credentialId, verified.value.counter);

    return new BackupFound({
      profile: new Profile({
        address: Schema.decodeSync(AccountAddress)(backup.address),
        username: Schema.decodeSync(Username)(boundUsername ?? backup.username),
      }),
      sealed: Schema.decodeSync(SealedPhrase)({
        iv: backup.iv,
        ciphertext: backup.ciphertext,
      }),
    });
  });

  return {
    passkeyChallenge: (purpose: ChallengePurpose) => backups.issue(purpose),
    enroll,
    restore,
  };
});
