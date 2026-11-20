import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Asset,
  type AddressBound,
  type AssertionRefused,
  type BackupStored,
  type ChallengeRefused,
  PaymentMemo,
  PositiveAmount,
  Recipient,
  type TransferDraft,
  TransferOrder,
  type TransferStep,
  type NoBackup,
  Profile,
  type RegistrationRefused,
  type Holding,
  type InvalidAddress,
  type NeedsReopening,
  type NotOpened,
  type NotSponsored,
  type Opened,
  type OpeningPending,
  Username,
  type UsernameTaken,
} from "../contract";
import { BackupState } from "./key-store";
import type { PasskeyCancelled, PasskeyFailed } from "./passkeys";

export class NoWallet extends Schema.TaggedClass<NoWallet>()("NoWallet", {}) {}

export const SavedBackup = Schema.Literals([...BackupState.literals, "none"]);

export type SavedBackup = typeof SavedBackup.Type;

export class SavedWallet extends Schema.TaggedClass<SavedWallet>()(
  "SavedWallet",
  {
    username: Username,
    openingApproved: Schema.Boolean,
    backup: SavedBackup,
  },
) {}

export type SavedOutcome = SavedWallet | NoWallet | UnsupportedDevice;

export class Offline extends Schema.TaggedClass<Offline>()("Offline", {}) {}

export class InvalidUsername extends Schema.TaggedClass<InvalidUsername>()(
  "InvalidUsername",
  {},
) {}

export class UnsupportedDevice extends Schema.TaggedClass<UnsupportedDevice>()(
  "UnsupportedDevice",
  {},
) {}

export class DraftRejected extends Schema.TaggedClass<DraftRejected>()(
  "DraftRejected",
  {},
) {}

export class BackupUnsupported extends Schema.TaggedClass<BackupUnsupported>()(
  "BackupUnsupported",
  {},
) {}

export class WalletOnDevice extends Schema.TaggedClass<WalletOnDevice>()(
  "WalletOnDevice",
  {},
) {}

export class BackupMismatch extends Schema.TaggedClass<BackupMismatch>()(
  "BackupMismatch",
  {},
) {}

export class Restored extends Schema.TaggedClass<Restored>()("Restored", {
  profile: Profile,
}) {}

export type EnrollmentRefusal =
  | PasskeyCancelled
  | PasskeyFailed
  | ChallengeRefused
  | RegistrationRefused
  | UnsupportedDevice;

export type BackUpOutcome =
  | BackupStored
  | BackupUnsupported
  | EnrollmentRefusal
  | NoWallet
  | Offline;

export type RestoreOutcome =
  | Restored
  | WalletOnDevice
  | BackupUnsupported
  | PasskeyCancelled
  | PasskeyFailed
  | ChallengeRefused
  | NoBackup
  | AssertionRefused
  | BackupMismatch
  | UnsupportedDevice
  | Offline;

export type DeviceOverview =
  | Holding
  | NeedsReopening
  | NotOpened
  | InvalidAddress
  | NoWallet
  | UnsupportedDevice
  | Offline;

export type CreateOutcome =
  | InvalidAddress
  | NotSponsored
  | Opened
  | OpeningPending
  | UsernameTaken
  | AddressBound
  | InvalidUsername
  | UnsupportedDevice
  | DraftRejected
  | EnrollmentRefusal
  | Offline;

export class TransferIntent extends Schema.Class<TransferIntent>(
  "@workspace/wallet/TransferIntent",
)({
  to: Recipient,
  asset: Asset,
  amount: PositiveAmount,
  memo: Schema.optional(PaymentMemo),
}) {}

export class ApprovalOutstanding extends Schema.TaggedClass<ApprovalOutstanding>()(
  "ApprovalOutstanding",
  { order: TransferOrder },
) {}

export type SendOutcome =
  | Exclude<TransferStep, TransferDraft>
  | ApprovalOutstanding
  | DraftRejected
  | NoWallet
  | UnsupportedDevice
  | Offline;

export class PaymentReview extends Schema.TaggedClass<PaymentReview>()(
  "PaymentReview",
  {
    order: TransferOrder,
    to: AccountAddress,
    username: Schema.optional(Username),
    asset: Asset,
    amount: PositiveAmount,
    memo: Schema.optional(PaymentMemo),
    claimable: Schema.Boolean,
    memoRequired: Schema.Boolean,
  },
) {}

export type ReviewOutcome = PaymentReview | SendOutcome;

export class NoTransfer extends Schema.TaggedClass<NoTransfer>()(
  "NoTransfer",
  {},
) {}

export type ResumeOutcome = NoTransfer | SendOutcome;
