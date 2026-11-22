import * as Data from "effect/Data";
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
  type ChallengeRefused,
  type PasskeyRegistration,
  Profile,
  RegistrationRefused,
  Username,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import { network } from "../stellar/network";
import {
  type AssertionCeremony,
  AssertionIntent,
  AssertionRejected,
  PinnedCredential,
  type RelyingParty,
  type WrongCredential,
  verifyPinnedAssertion,
} from "./assertion";
import {
  type CorruptDeviceWallet,
  type KeyStoreUnavailable,
  PublicDeviceWallet,
  SealedDeviceWallet,
  type SealedKeyStore,
} from "./key-store";
import {
  type CorruptEnvelope,
  LocalPhraseEnvelope,
  freshInstallationSalt,
  localEnvelopeVersion,
  localPhrasePrfInput,
  reopenLocalEnvelope,
  sealLocalEnvelope,
} from "./local-envelope";
import {
  BackupUnsupported,
  InvalidUsername,
  NoWallet,
  UnsupportedDevice,
  WalletOnDevice,
} from "./outcomes";
import type {
  PasskeyCancelled,
  PasskeyFailed,
  RegistrationCeremony,
} from "./passkeys";
import { backupSalt, sealPhrase } from "./phrase-seal";
import { type SecretPhrase, generateSecretPhrase } from "./secret-phrase";
import { signingKey } from "./signing";

export const EnrollmentStage = Schema.Literals(["prf", "backup", "reopen"]);

export type EnrollmentStage = typeof EnrollmentStage.Type;

export class EnrollmentPending extends Schema.TaggedClass<EnrollmentPending>()(
  "EnrollmentPending",
  {
    stage: EnrollmentStage,
    username: Username,
  },
) {}

export class WalletEnrolled extends Schema.TaggedClass<WalletEnrolled>()(
  "WalletEnrolled",
  {
    profile: Profile,
  },
) {}

export class PendingReopenCandidate extends Schema.Class<PendingReopenCandidate>(
  "@workspace/wallet/PendingReopenCandidate",
)({
  username: Username,
  address: AccountAddress,
  credential: PinnedCredential,
  envelope: LocalPhraseEnvelope,
}) {}

export class PendingBackupSubmission extends Schema.TaggedClass<PendingBackupSubmission>()(
  "PendingBackupSubmission",
  {
    enrollment: BackupEnrollment,
    candidate: PendingReopenCandidate,
  },
) {}

export class PendingReopenProof extends Schema.TaggedClass<PendingReopenProof>()(
  "PendingReopenProof",
  {
    candidate: PendingReopenCandidate,
  },
) {}

export const PendingEnrollmentRecord = Schema.Union([
  PendingBackupSubmission,
  PendingReopenProof,
]);

export type PendingEnrollmentRecord = typeof PendingEnrollmentRecord.Type;

export interface PendingEnrollmentStorage {
  read(): Effect.Effect<Option.Option<PendingEnrollmentRecord>>;
  write(
    record: PendingEnrollmentRecord,
  ): Effect.Effect<void, KeyStoreUnavailable>;
  clear(): Effect.Effect<void>;
}

export type EnrollWalletOutcome =
  | EnrollmentPending
  | WalletEnrolled
  | NoWallet
  | InvalidUsername
  | WalletOnDevice
  | BackupUnsupported
  | PasskeyCancelled
  | PasskeyFailed
  | WrongCredential
  | AssertionRejected
  | CorruptEnvelope
  | CorruptDeviceWallet
  | ChallengeRefused
  | RegistrationRefused
  | UnsupportedDevice
  | WalletUnavailable;

export interface EnrollmentDependencies {
  readonly port: Pick<WalletPort, "passkeyChallenge" | "enroll">;
  readonly store: SealedKeyStore;
  readonly registration: RegistrationCeremony;
  readonly assertions: AssertionCeremony;
  readonly relyingParty: RelyingParty;
  readonly pending?: PendingEnrollmentStorage;
}

export interface EnrollmentEffects {
  pending(): Effect.Effect<Option.Option<EnrollmentPending>>;
  start(usernameText: string): Effect.Effect<EnrollWalletOutcome>;
  advance(): Effect.Effect<EnrollWalletOutcome>;
}

export interface EnrollmentClient {
  pending(): Promise<Option.Option<EnrollmentPending>>;
  start(usernameText: string): Promise<EnrollWalletOutcome>;
  advance(): Promise<EnrollWalletOutcome>;
}

interface EnrollmentMaterial {
  readonly username: Username;
  readonly address: AccountAddress;
  readonly phrase: SecretPhrase;
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly registration: PasskeyRegistration;
  readonly credential: PinnedCredential;
}

type PendingState = Data.TaggedEnum<{
  Idle: {};
  AwaitingPrf: {
    readonly username: Username;
    readonly address: AccountAddress;
    readonly phrase: Redacted.Redacted<SecretPhrase>;
    readonly salt: Uint8Array<ArrayBuffer>;
    readonly registration: PasskeyRegistration;
    readonly credential: PinnedCredential;
  };
  AwaitingBackupStore: {
    readonly enrollment: BackupEnrollment;
    readonly candidate: PendingReopenCandidate;
  };
  AwaitingReopenProof: {
    readonly candidate: PendingReopenCandidate;
  };
}>;

const PendingState = Data.taggedEnum<PendingState>();

const pinnedAlgorithm = (
  algorithm: number,
): Option.Option<PinnedCredential["algorithm"]> =>
  algorithm === -7
    ? Option.some("ES256")
    : algorithm === -257
      ? Option.some("RS256")
      : Option.none();

const pinCredential = (
  registration: PasskeyRegistration,
): Option.Option<PinnedCredential> =>
  pinnedAlgorithm(registration.publicKeyAlgorithm).pipe(
    Option.map(
      (algorithm) =>
        new PinnedCredential({
          id: registration.id,
          publicKey: registration.publicKey,
          algorithm,
        }),
    ),
  );

const isRetryableUnavailable = (failure: WalletUnavailable) =>
  Predicate.isTagged(failure, "Offline") ||
  Predicate.isTagged(failure, "ServerUnreachable") ||
  Predicate.isTagged(failure, "LedgerUnreachable");

const pendingNotice = (state: PendingState): Option.Option<EnrollmentPending> =>
  PendingState.$match(state, {
    Idle: () => Option.none(),
    AwaitingPrf: ({ username }) =>
      Option.some(new EnrollmentPending({ stage: "prf", username })),
    AwaitingBackupStore: ({ candidate }) =>
      Option.some(
        new EnrollmentPending({
          stage: "backup",
          username: candidate.username,
        }),
      ),
    AwaitingReopenProof: ({ candidate }) =>
      Option.some(
        new EnrollmentPending({
          stage: "reopen",
          username: candidate.username,
        }),
      ),
  });

const zeroOptional = (bytes: Option.Option<Uint8Array<ArrayBuffer>>) => {
  if (Option.isSome(bytes)) bytes.value.fill(0);
};

export function makeEnrollmentEffects(
  deps: EnrollmentDependencies,
): EnrollmentEffects {
  let state: PendingState = PendingState.Idle();
  const lock = Semaphore.makeUnsafe(1);

  const clearPending = Effect.gen(function* () {
    state = PendingState.Idle();

    if (deps.pending !== undefined) yield* deps.pending.clear();
  });

  const loadPending = Effect.gen(function* () {
    if (!PendingState.$is("Idle")(state)) return state;

    if (deps.pending === undefined) return state;

    const restored = yield* deps.pending.read();

    if (Option.isSome(restored))
      state = Match.valueTags(restored.value, {
        PendingBackupSubmission: ({ enrollment, candidate }) =>
          PendingState.AwaitingBackupStore({ enrollment, candidate }),
        PendingReopenProof: ({ candidate }) =>
          PendingState.AwaitingReopenProof({ candidate }),
      });

    return state;
  });

  const requireNoInstalledWallet = deps.store.readPublic().pipe(
    Effect.flatMap((existing) =>
      Option.isSome(existing)
        ? clearPending.pipe(
            Effect.as(Option.some<EnrollWalletOutcome>(new WalletOnDevice())),
          )
        : Effect.succeed(Option.none<EnrollWalletOutcome>()),
    ),
    Effect.catchTags({
      CorruptDeviceWallet: (corrupt) =>
        Effect.succeed(Option.some<EnrollWalletOutcome>(corrupt)),
      KeyStoreUnavailable: () =>
        Effect.succeed(
          Option.some<EnrollWalletOutcome>(new UnsupportedDevice()),
        ),
    }),
  );

  const uploadBackup = Effect.fn("Device.uploadEnrollmentBackup")(function* (
    enrollment: BackupEnrollment,
    candidate: PendingReopenCandidate,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    const enrolled = yield* deps.port.enroll(enrollment).pipe(Effect.result);

    if (Result.isFailure(enrolled)) {
      if (!isRetryableUnavailable(enrolled.failure)) yield* clearPending;

      return enrolled.failure;
    }

    return yield* Match.valueTags(enrolled.success, {
      BackupStored: () =>
        Effect.gen(function* () {
          state = PendingState.AwaitingReopenProof({ candidate });

          if (deps.pending !== undefined)
            yield* deps.pending
              .write(new PendingReopenProof({ candidate }))
              .pipe(Effect.ignore);

          return new EnrollmentPending({
            stage: "reopen",
            username: candidate.username,
          });
        }),
      ChallengeRefused: (refused) => clearPending.pipe(Effect.as(refused)),
      RegistrationRefused: (refused) => clearPending.pipe(Effect.as(refused)),
    });
  });

  const submitBackup = Effect.fn("Device.submitEnrollmentBackup")(function* (
    enrollment: BackupEnrollment,
    candidate: PendingReopenCandidate,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    if (deps.pending !== undefined) {
      const persisted = yield* deps.pending
        .write(new PendingBackupSubmission({ enrollment, candidate }))
        .pipe(Effect.result);

      if (Result.isFailure(persisted))
        return yield* clearPending.pipe(Effect.as(new UnsupportedDevice()));
    }

    state = PendingState.AwaitingBackupStore({ enrollment, candidate });

    return yield* uploadBackup(enrollment, candidate);
  });

  const sealAndStoreBackup = Effect.fn("Device.sealEnrollmentBackup")(
    function* (
      material: EnrollmentMaterial,
      backupPrf: Uint8Array<ArrayBuffer>,
      devicePrf: Uint8Array<ArrayBuffer>,
    ): Effect.fn.Return<EnrollWalletOutcome> {
      const sealedBackup = yield* sealPhrase(backupPrf, material.phrase);

      const sealedLocal = yield* sealLocalEnvelope(
        {
          phrase: material.phrase,
          network,
          address: material.address,
          credentialId: material.credential.id,
          salt: material.salt,
        },
        Redacted.make(devicePrf),
      );

      return yield* Match.valueTags(sealedLocal, {
        CorruptEnvelope: (corrupt) => clearPending.pipe(Effect.as(corrupt)),
        EnvelopeSealed: ({ envelope }) => {
          const candidate = new PendingReopenCandidate({
            username: material.username,
            address: material.address,
            credential: material.credential,
            envelope,
          });

          const enrollment = new BackupEnrollment({
            address: material.address,
            username: material.username,
            registration: material.registration,
            sealed: sealedBackup,
          });

          return submitBackup(enrollment, candidate);
        },
      });
    },
  );

  const start = Effect.fn("Device.startEnrollment")(function* (
    usernameText: string,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    const username = Schema.decodeUnknownOption(Username)(usernameText);

    if (Option.isNone(username)) return new InvalidUsername();

    const blocked = yield* requireNoInstalledWallet;

    if (Option.isSome(blocked)) return blocked.value;

    const existingPending = pendingNotice(yield* loadPending);

    if (Option.isSome(existingPending)) return existingPending.value;

    const phrase = generateSecretPhrase();

    const address = Schema.decodeSync(AccountAddress)(
      signingKey(phrase).publicKey(),
    );

    const salt = freshInstallationSalt();
    const backupInput = yield* backupSalt;

    const deviceInput = yield* localPhrasePrfInput({
      network,
      address,
      salt,
    });

    const challenge = yield* deps.port
      .passkeyChallenge("enrollment")
      .pipe(Effect.result);

    if (Result.isFailure(challenge)) return challenge.failure;

    const registered = yield* deps.registration
      .register({
        challenge: challenge.success,
        username: username.value,
        prf: {
          first: backupInput,
          second: Option.some(deviceInput),
        },
      })
      .pipe(Effect.result);

    if (Result.isFailure(registered)) return registered.failure;

    if (Option.isNone(registered.success)) return new BackupUnsupported();

    const platform = registered.success.value;

    return yield* Effect.gen(function* () {
      const credential = pinCredential(platform.registration);

      if (Option.isNone(credential)) return new RegistrationRefused();

      if (
        Option.isSome(platform.prf.first) &&
        Option.isSome(platform.prf.second)
      )
        return yield* sealAndStoreBackup(
          {
            username: username.value,
            address,
            phrase,
            salt,
            registration: platform.registration,
            credential: credential.value,
          },
          platform.prf.first.value,
          platform.prf.second.value,
        );

      state = PendingState.AwaitingPrf({
        username: username.value,
        address,
        phrase: Redacted.make(phrase),
        salt,
        registration: platform.registration,
        credential: credential.value,
      });

      return new EnrollmentPending({ stage: "prf", username: username.value });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          zeroOptional(platform.prf.first);
          zeroOptional(platform.prf.second);
        }),
      ),
    );
  });

  const obtainPrf = Effect.fn("Device.obtainEnrollmentPrf")(function* (
    pending: Extract<PendingState, { readonly _tag: "AwaitingPrf" }>,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    const deviceInput = yield* localPhrasePrfInput({
      network,
      address: pending.address,
      salt: pending.salt,
    });

    const backupInput = yield* backupSalt;

    const verified = yield* verifyPinnedAssertion(
      deps.assertions,
      deps.relyingParty,
      pending.credential,
      AssertionIntent.Operation({
        purpose: "backup",
        prf: {
          first: deviceInput,
          second: Option.some(backupInput),
        },
      }),
    ).pipe(Effect.result);

    if (Result.isFailure(verified)) return verified.failure;

    return yield* Match.valueTags(verified.success, {
      OperationVerified: ({ prf }) =>
        Effect.gen(function* () {
          if (Option.isNone(prf.second)) {
            yield* clearPending;

            return new BackupUnsupported();
          }

          return yield* sealAndStoreBackup(
            {
              username: pending.username,
              address: pending.address,
              phrase: Redacted.value(pending.phrase),
              salt: pending.salt,
              registration: pending.registration,
              credential: pending.credential,
            },
            Redacted.value(prf.second.value),
            Redacted.value(prf.first),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Redacted.value(prf.first).fill(0);

              if (Option.isSome(prf.second))
                Redacted.value(prf.second.value).fill(0);
            }),
          ),
        ),
      EntryVerified: () => Effect.succeed(new AssertionRejected()),
      WrongCredential: Effect.succeed,
      AssertionRejected: Effect.succeed,
      PrfOutputMissing: () =>
        clearPending.pipe(Effect.as(new BackupUnsupported())),
    });
  });

  const proveReopen = Effect.fn("Device.proveEnrollmentReopen")(function* (
    candidate: PendingReopenCandidate,
  ): Effect.fn.Return<EnrollWalletOutcome> {
    const reopened = yield* reopenLocalEnvelope(
      deps.assertions,
      deps.relyingParty,
      candidate.credential,
      candidate.envelope,
      {
        network,
        address: candidate.address,
        purpose: "backup",
      },
    ).pipe(Effect.result);

    if (Result.isFailure(reopened)) return reopened.failure;

    return yield* Match.valueTags(reopened.success, {
      PhraseOpened: () =>
        Effect.gen(function* () {
          const record = new SealedDeviceWallet({
            version: localEnvelopeVersion,
            public: new PublicDeviceWallet({
              address: candidate.address,
              username: candidate.username,
              backup: "stored",
            }),
            credential: candidate.credential,
            envelope: candidate.envelope,
          });

          const installed = yield* deps.store
            .installSealed(record)
            .pipe(Effect.result);

          if (Result.isFailure(installed))
            return Match.valueTags(installed.failure, {
              CorruptDeviceWallet: (corrupt) => corrupt,
              KeyStoreUnavailable: () => new UnsupportedDevice(),
            });

          yield* clearPending;

          return installed.success
            ? new WalletEnrolled({
                profile: new Profile({
                  address: candidate.address,
                  username: candidate.username,
                }),
              })
            : new WalletOnDevice();
        }),
      CorruptEnvelope: (corrupt) => clearPending.pipe(Effect.as(corrupt)),
      WrongCredential: Effect.succeed,
      AssertionRejected: Effect.succeed,
      PrfOutputMissing: () =>
        clearPending.pipe(Effect.as(new BackupUnsupported())),
    });
  });

  const advance = Effect.fn("Device.advanceEnrollment")(
    function* (): Effect.fn.Return<EnrollWalletOutcome> {
      const blocked = yield* requireNoInstalledWallet;

      if (Option.isSome(blocked)) return blocked.value;

      const current = yield* loadPending;

      return yield* PendingState.$match(current, {
        Idle: () => Effect.succeed(new NoWallet()),
        AwaitingPrf: obtainPrf,
        AwaitingBackupStore: ({ enrollment, candidate }) =>
          uploadBackup(enrollment, candidate),
        AwaitingReopenProof: ({ candidate }) => proveReopen(candidate),
      });
    },
  );

  const pending = Effect.fn("Device.pendingEnrollment")(function* () {
    const installed = yield* deps.store.readPublic().pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    );

    if (installed) {
      yield* clearPending;

      return Option.none<EnrollmentPending>();
    }

    return pendingNotice(yield* loadPending);
  });

  return {
    pending: () => lock.withPermit(pending()),
    start: (usernameText) => lock.withPermit(start(usernameText)),
    advance: () => lock.withPermit(advance()),
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
  };
}
