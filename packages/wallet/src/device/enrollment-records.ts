import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Approvals,
  BackupEnrollment,
  type ChallengeRefused,
  type OpeningPending,
  Profile,
  type RegistrationRefused,
  type UsernameTaken,
  Username,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import {
  type AssertionCeremony,
  type AssertionRejected,
  PinnedCredential,
  type RelyingParty,
  type WrongCredential,
} from "./assertion";
import type {
  CorruptDeviceWallet,
  KeyStoreUnavailable,
  SealedKeyStore,
} from "./key-store";
import { type CorruptEnvelope, LocalPhraseEnvelope } from "./local-envelope";
import type {
  BackupUnsupported,
  DraftRejected,
  InvalidUsername,
  NoWallet,
  UnsupportedDevice,
  WalletOnDevice,
} from "./outcomes";
import { OpeningReview } from "./outcomes";
import type {
  PasskeyCancelled,
  PasskeyFailed,
  RegistrationCeremony,
} from "./passkeys";

export const EnrollmentStage = Schema.Literals(["activate", "release"]);

export type EnrollmentStage = typeof EnrollmentStage.Type;

export class EnrollmentPending extends Schema.TaggedClass<EnrollmentPending>()(
  "EnrollmentPending",
  {
    stage: EnrollmentStage,
    username: Username,
    currentUntil: Schema.optional(Schema.Number),
  },
) {}

export class WalletEnrolled extends Schema.TaggedClass<WalletEnrolled>()(
  "WalletEnrolled",
  {
    profile: Profile,
  },
) {}

export class PendingCandidate extends Schema.Class<PendingCandidate>(
  "@workspace/wallet/PendingCandidate",
)({
  username: Username,
  address: AccountAddress,
  credential: PinnedCredential,
  envelope: LocalPhraseEnvelope,
}) {}

export class PendingActivation extends Schema.TaggedClass<PendingActivation>()(
  "PendingActivation",
  {
    enrollment: BackupEnrollment,
    candidate: PendingCandidate,
  },
) {}

export class PendingRelease extends Schema.TaggedClass<PendingRelease>()(
  "PendingRelease",
  {
    enrollment: BackupEnrollment,
    candidate: PendingCandidate,
    review: OpeningReview,
    approvals: Approvals,
  },
) {}

export const PendingEnrollmentRecord = Schema.Union([
  PendingActivation,
  PendingRelease,
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
  | OpeningPending
  | NoWallet
  | InvalidUsername
  | UsernameTaken
  | WalletOnDevice
  | BackupUnsupported
  | DraftRejected
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
  readonly port: Pick<WalletPort, "passkeyChallenge" | "enroll" | "open">;
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
