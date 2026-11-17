import type * as Effect from "effect/Effect";
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
import { AccountAddress, Profile, Username } from "./identity";

export * from "./approval";

export * from "./asset-orders";

export * from "./assets";

export * from "./identity";

export class InvalidAddress extends Schema.TaggedClass<InvalidAddress>()(
  "InvalidAddress",
  {
    address: AccountAddress,
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

// --- opening a wallet ---------------------------------------------------

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

/** This address is already bound to another username. Names never change hands or get renamed. */
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

/** External deposit references use the SDK's text/id memo kinds and wire limits. */
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
  {},
) {}

// --- transfers ----------------------------------------------------------

/** Minted on the phone with crypto.randomUUID() before any network call. */
export const TransferId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("TransferId"),
);

export type TransferId = typeof TransferId.Type;

// Recipient variants carry a username, phone or address; phone support is deferred.
export const UsernameRecipient = Schema.TaggedStruct("Username", {
  value: Username,
});

export const PhoneRecipient = Schema.TaggedStruct("Phone", {
  value: Schema.String,
});

export const AddressRecipient = Schema.TaggedStruct("Address", {
  value: AccountAddress,
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

/** An external destination has no Orchid username. */
export class ExternalRecipient extends Schema.Class<ExternalRecipient>(
  "@workspace/wallet/ExternalRecipient",
)({ address: AccountAddress }) {}

export const ResolvedRecipient = Schema.Union([Profile, ExternalRecipient]);

export type ResolvedRecipient = typeof ResolvedRecipient.Type;

const transferFields = {
  id: TransferId,
  to: Recipient,
  recipient: ResolvedRecipient,
  asset: Asset,
  amount: PositiveAmount,
  memo: Schema.optional(PaymentMemo),
  // Present when the money waits in a claimable balance the recipient must claim.
  claimable: Schema.optional(BalanceId),
};

/** Signed, stored, on its way. It will become Settled or Failed without the phone. */
export class Pending extends Schema.TaggedClass<Pending>()("Pending", {
  ...transferFields,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

/** The transaction applied. With `claimable`, the recipient holds the money only after claiming it. */
export class Settled extends Schema.TaggedClass<Settled>()("Settled", {
  ...transferFields,
  settledAt: Schema.DateTimeUtcFromString,
}) {}

/** Proven not to have moved money, and proven unable to. */
export class Failed extends Schema.TaggedClass<Failed>()("Failed", {
  ...transferFields,
  reason: Schema.Literals(["expired", "rejected"]),
}) {}

// Escrow-specific fields and transitions are defined when phone transfers are implemented.
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
    // Present when the recipient has no trustline: the draft creates this claimable balance.
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

/**
 * A payment to this address would fail, and Orchid sponsors a claimable
 * balance only for its own wallets.
 */
export class RecipientCannotReceive extends Schema.TaggedClass<RecipientCannotReceive>()(
  "RecipientCannotReceive",
  {
    address: AccountAddress,
    reason: Schema.Literals(["no_account", "no_trustline", "not_authorized"]),
  },
) {}

/** The sender already has `limit` unclaimed balances. One must be claimed or reclaimed first. */
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

// --- asset orders -------------------------------------------------------

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

// --- overview -----------------------------------------------------------

export class Balance extends Schema.Class<Balance>("@workspace/wallet/Balance")(
  {
    asset: Asset,
    amount: Amount,
  },
) {}

/**
 * An unclaimed balance this wallet sent or was sent. The recipient may claim
 * now; `claimableAt` is when the sender may take it back.
 */
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
  // The opening asset first, then XLM when held, then every other open trustline Orchid tracks.
  balances: Schema.Array(Balance),
  claimable: Schema.Array(ClaimableBalance),
  latest: Schema.OptionFromNullOr(Receipt), // the sender's latest authorized or concluded transfer
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

// --- failure and the port ----------------------------------------------

/** The outcome is unknown. Every call below is safe to repeat with the same arguments. */
export class WalletUnavailable extends Schema.TaggedError<WalletUnavailable>()(
  "WalletUnavailable",
  { cause: Schema.Defect() },
) {}

/**
 * The port a phone can call. Defined once. The server service implements it,
 * the app's server functions carry it, and the device client consumes it.
 */
export interface WalletPort {
  overview(address: AccountAddress): Effect.Effect<Overview, WalletUnavailable>;
  open(
    claim: WalletClaim,
    approval: Option.Option<Approval>,
  ): Effect.Effect<OpenStep, WalletUnavailable>;
  transfer(
    order: TransferOrder,
    approval: Option.Option<Approval>,
  ): Effect.Effect<TransferStep, WalletUnavailable>;
  manage(
    order: AssetOrder,
    approval: Option.Option<Approval>,
  ): Effect.Effect<AssetStep, WalletUnavailable>;
}
