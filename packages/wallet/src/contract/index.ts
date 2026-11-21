import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Approval, SigningRequest } from "./approval";
import {
  AssetBusy,
  AssetDraft,
  AssetFailed,
  AssetOrder,
  AssetPending,
  AssetSettled,
  AssetUnsupported,
  BalanceGone,
  NotClaimable,
  TrustlineLimitReached,
  TrustlineNotEmpty,
  Unchanged,
} from "./asset-orders";
import { Amount, Asset, BalanceId, PositiveAmount } from "./assets";
import type {
  BackupEnrollment,
  ChallengePurpose,
  EnrollStep,
  PasskeyAssertion,
  PasskeyChallenge,
  RestoreStep,
} from "./backup";
import {
  AccountAddress,
  DestinationAddress,
  Profile,
  Username,
} from "./identity";

export * from "./approval";

export * from "./asset-orders";

export * from "./assets";

export * from "./backup";

export * from "./identity";

export * from "./network-addresses";

export class InvalidAddress extends Schema.TaggedClass<InvalidAddress>()(
  "InvalidAddress",
  {
    address: DestinationAddress,
  },
) {}

export class NotSponsored extends Schema.TaggedClass<NotSponsored>()(
  "NotSponsored",
  {},
) {}

export class ExternalMemoRequired extends Schema.TaggedClass<ExternalMemoRequired>()(
  "ExternalMemoRequired",
  {
    address: AccountAddress,
    exchange: Schema.NonEmptyString,
    source: Schema.String,
  },
) {}

export class WalletClaim extends Schema.Class<WalletClaim>(
  "@workspace/wallet/WalletClaim",
)({
  username: Username,
  address: AccountAddress,
}) {}

export class OpeningDraft extends Schema.TaggedClass<OpeningDraft>()(
  "OpeningDraft",
  {
    request: SigningRequest,
  },
) {}

export class RecoveryDraft extends Schema.TaggedClass<RecoveryDraft>()(
  "RecoveryDraft",
  {
    request: SigningRequest,
  },
) {}

export class OpeningPending extends Schema.TaggedClass<OpeningPending>()(
  "OpeningPending",
  {},
) {}

export class Opened extends Schema.TaggedClass<Opened>()("Opened", {
  profile: Profile,
}) {}

export class UsernameTaken extends Schema.TaggedClass<UsernameTaken>()(
  "UsernameTaken",
  {
    username: Username,
  },
) {}

export class AddressBound extends Schema.TaggedClass<AddressBound>()(
  "AddressBound",
  {
    profile: Profile,
  },
) {}

export const OpenStep = Schema.Union([
  OpeningDraft,
  RecoveryDraft,
  OpeningPending,
  Opened,
  UsernameTaken,
  AddressBound,
  InvalidAddress,
  NotSponsored,
]);

export type OpenStep = typeof OpenStep.Type;

export const PaymentMemo = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    value: Schema.String.check(
      Schema.makeFilter((value) => {
        const bytes = new TextEncoder().encode(value);

        return (
          bytes.length > 0 &&
          bytes.length <= 28 &&
          new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) === value
        );
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("id"),
    value: Schema.String.check(
      Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/),
      Schema.makeFilter(
        (value) =>
          /^[0-9]+$/.test(value) && BigInt(value) <= 18446744073709551615n,
      ),
    ),
  }),
]);

export type PaymentMemo = typeof PaymentMemo.Type;

export class MemoNotAllowed extends Schema.TaggedClass<MemoNotAllowed>()(
  "MemoNotAllowed",
  { reason: Schema.Literals(["orchid", "muxed"]) },
) {}

export const TransferId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("TransferId"),
);

export type TransferId = typeof TransferId.Type;

export const UsernameRecipient = Schema.TaggedStruct("Username", {
  value: Username,
});

export const PhoneRecipient = Schema.TaggedStruct("Phone", {
  value: Schema.String,
});

export const AddressRecipient = Schema.TaggedStruct("Address", {
  value: DestinationAddress,
});

export const Recipient = Schema.Union([
  UsernameRecipient,
  PhoneRecipient,
  AddressRecipient,
]);

export type Recipient = typeof Recipient.Type;

export class TransferOrder extends Schema.Class<TransferOrder>(
  "@workspace/wallet/TransferOrder",
)({
  id: TransferId,
  from: AccountAddress,
  to: Recipient,
  asset: Asset,
  amount: PositiveAmount,
  memo: Schema.optional(PaymentMemo),
}) {}

export class ExternalRecipient extends Schema.Class<ExternalRecipient>(
  "@workspace/wallet/ExternalRecipient",
)({ address: DestinationAddress }) {}

export const ResolvedRecipient = Schema.Union([Profile, ExternalRecipient]);

export type ResolvedRecipient = typeof ResolvedRecipient.Type;

const transferFields = {
  id: TransferId,
  to: Recipient,
  recipient: ResolvedRecipient,
  asset: Asset,
  amount: PositiveAmount,
  memo: Schema.optional(PaymentMemo),

  claimable: Schema.optional(BalanceId),
};

export class Pending extends Schema.TaggedClass<Pending>()("Pending", {
  ...transferFields,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

export class Settled extends Schema.TaggedClass<Settled>()("Settled", {
  ...transferFields,
  settledAt: Schema.DateTimeUtcFromString,
}) {}

export class Failed extends Schema.TaggedClass<Failed>()("Failed", {
  ...transferFields,
  reason: Schema.Literals(["expired", "rejected"]),
}) {}

export class Reserved extends Schema.TaggedClass<Reserved>()(
  "Reserved",
  transferFields,
) {}

export class Claimed extends Schema.TaggedClass<Claimed>()(
  "Claimed",
  transferFields,
) {}

export class Refunded extends Schema.TaggedClass<Refunded>()(
  "Refunded",
  transferFields,
) {}

export const Receipt = Schema.Union([
  Pending,
  Settled,
  Failed,
  Reserved,
  Claimed,
  Refunded,
]);

export type Receipt = typeof Receipt.Type;

export class TransferDraft extends Schema.TaggedClass<TransferDraft>()(
  "TransferDraft",
  {
    request: SigningRequest,
    recipient: ResolvedRecipient,
    memoRequired: Schema.Boolean,

    claimable: Schema.optional(BalanceId),
  },
) {}

export class NotOpened extends Schema.TaggedClass<NotOpened>()(
  "NotOpened",
  {},
) {}

export class UnknownRecipient extends Schema.TaggedClass<UnknownRecipient>()(
  "UnknownRecipient",
  {
    username: Username,
  },
) {}

export class PhoneNotSupported extends Schema.TaggedClass<PhoneNotSupported>()(
  "PhoneNotSupported",
  {},
) {}

export class InsufficientBalance extends Schema.TaggedClass<InsufficientBalance>()(
  "InsufficientBalance",
  { available: Amount },
) {}

export class RecipientCannotReceive extends Schema.TaggedClass<RecipientCannotReceive>()(
  "RecipientCannotReceive",
  {
    address: AccountAddress,
    reason: Schema.Literals([
      "no_account",
      "no_trustline",
      "not_authorized",
      "no_capacity",
    ]),
  },
) {}

export class ClaimableLimitReached extends Schema.TaggedClass<ClaimableLimitReached>()(
  "ClaimableLimitReached",
  { limit: Schema.Number },
) {}

export class SenderBusy extends Schema.TaggedClass<SenderBusy>()("SenderBusy", {
  inFlight: Pending,
}) {}

export const TransferStep = Schema.Union([
  TransferDraft,
  Pending,
  Settled,
  Failed,
  NotOpened,
  UnknownRecipient,
  PhoneNotSupported,
  InsufficientBalance,
  SenderBusy,
  InvalidAddress,
  ExternalMemoRequired,
  MemoNotAllowed,
  RecipientCannotReceive,
  ClaimableLimitReached,
  AssetBusy,
]);

export type TransferStep = typeof TransferStep.Type;

export const AssetStep = Schema.Union([
  AssetDraft,
  AssetPending,
  AssetSettled,
  AssetFailed,
  NotOpened,
  InvalidAddress,
  SenderBusy,
  AssetBusy,
  Unchanged,
  TrustlineLimitReached,
  TrustlineNotEmpty,
  AssetUnsupported,
  NotClaimable,
  BalanceGone,
]);

export type AssetStep = typeof AssetStep.Type;

export class Balance extends Schema.Class<Balance>("@workspace/wallet/Balance")(
  {
    asset: Asset,
    amount: Amount,
  },
) {}

export class ClaimableBalance extends Schema.Class<ClaimableBalance>(
  "@workspace/wallet/ClaimableBalance",
)({
  balance: BalanceId,
  asset: Asset,
  amount: PositiveAmount,
  from: Profile,
  to: Profile,
  claimableAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {}

export class Holding extends Schema.TaggedClass<Holding>()("Holding", {
  profile: Profile,
  reserveSponsor: Schema.OptionFromNullOr(AccountAddress).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  balances: Schema.Array(Balance),
  claimable: Schema.Array(ClaimableBalance),
  latest: Schema.OptionFromNullOr(Receipt),
}) {}

export class NeedsReopening extends Schema.TaggedClass<NeedsReopening>()(
  "NeedsReopening",
  {
    profile: Profile,
  },
) {}

export const Overview = Schema.Union([
  NotOpened,
  Holding,
  NeedsReopening,
  InvalidAddress,
]);

export type Overview = typeof Overview.Type;

export class Offline extends Schema.TaggedError<Offline>()("Offline", {}) {}

export class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()(
  "ServerUnreachable",
  {},
) {}

export class LedgerUnreachable extends Schema.TaggedError<LedgerUnreachable>()(
  "LedgerUnreachable",
  {},
) {}

export class ServiceFailed extends Schema.TaggedError<ServiceFailed>()(
  "ServiceFailed",
  {},
) {}

export class InvalidResponse extends Schema.TaggedError<InvalidResponse>()(
  "InvalidResponse",
  {},
) {}

export const ServerFailure = Schema.Union([LedgerUnreachable, ServiceFailed]);

export type ServerFailure = typeof ServerFailure.Type;

export const WalletUnavailable = Schema.Union([
  Offline,
  ServerUnreachable,
  LedgerUnreachable,
  ServiceFailed,
  InvalidResponse,
]);

export type WalletUnavailable = typeof WalletUnavailable.Type;

export interface WalletPort<E = WalletUnavailable> {
  overview(address: AccountAddress): Effect.Effect<Overview, E>;
  open(
    claim: WalletClaim,
    approval: Option.Option<Approval>,
  ): Effect.Effect<OpenStep, E>;
  transfer(
    order: TransferOrder,
    approval: Option.Option<Approval>,
  ): Effect.Effect<TransferStep, E>;
  manage(
    order: AssetOrder,
    approval: Option.Option<Approval>,
  ): Effect.Effect<AssetStep, E>;
  passkeyChallenge(
    purpose: ChallengePurpose,
  ): Effect.Effect<PasskeyChallenge, E>;
  enroll(enrollment: BackupEnrollment): Effect.Effect<EnrollStep, E>;
  restore(assertion: PasskeyAssertion): Effect.Effect<RestoreStep, E>;
}
