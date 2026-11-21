import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type AssetDraft,
  type AssetStep,
  Asset,
  BalanceId,
  DestinationAddress,
  LinkSecret,
  type AddressBound,
  type AssertionRefused,
  type BackupStored,
  type ChallengeRefused,
  PaymentMemo,
  type PaymentLinksStep,
  PositiveAmount,
  Recipient,
  type Receipt,
  type ResolveReceiptStep,
  type Pending,
  type Settled,
  type TransferDraft,
  TransferId,
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
  type WalletUnavailable,
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

export type SavedOutcome =
  | SavedWallet
  | NoWallet
  | UnsupportedDevice
  | WalletUnavailable;

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
  | WalletUnavailable;

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
  | WalletUnavailable;

export type DeviceOverview =
  | Holding
  | NeedsReopening
  | NotOpened
  | InvalidAddress
  | NoWallet
  | UnsupportedDevice
  | WalletUnavailable;

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
  | WalletUnavailable;

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
  | WalletUnavailable;

export class PaymentReview extends Schema.TaggedClass<PaymentReview>()(
  "PaymentReview",
  {
    order: TransferOrder,
    to: DestinationAddress,
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

export type ResumeOutcome = NoTransfer | SendOutcome | Receipt;

export class PaymentLinkIntent extends Schema.Class<PaymentLinkIntent>(
  "@workspace/wallet/PaymentLinkIntent",
)({
  asset: Asset,
  amount: PositiveAmount,
}) {}

export class PaymentLinkCreated extends Schema.TaggedClass<PaymentLinkCreated>()(
  "PaymentLinkCreated",
  {
    id: TransferId,
    address: AccountAddress,
    secret: LinkSecret,
    balance: BalanceId,
    asset: Asset,
    amount: PositiveAmount,
    network: Schema.String,
    path: Schema.String,
    settledAt: Schema.DateTimeUtcFromString,
  },
) {}

export type CreatePaymentLinkOutcome =
  | PaymentLinkCreated
  | Exclude<SendOutcome, Settled>;

export type PaymentLinksOutcome =
  | PaymentLinksStep
  | NoWallet
  | UnsupportedDevice
  | WalletUnavailable;

export type ResolvePaymentLinkOutcome =
  | ResolveReceiptStep
  | Pending
  | ApprovalOutstanding
  | NoWallet
  | UnsupportedDevice
  | WalletUnavailable;

export type CancelPaymentLinkOutcome =
  | Exclude<AssetStep, AssetDraft>
  | DraftRejected
  | NoWallet
  | UnsupportedDevice
  | WalletUnavailable;
