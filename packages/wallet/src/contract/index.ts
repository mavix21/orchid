import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// --- identity -----------------------------------------------------------

/** Lowercase, 3 to 20 of a–z 0–9 underscore. The "@" is display only. */
export const Username = Schema.String.check(Schema.isPattern(/^[a-z0-9_]{3,20}$/)).pipe(
  Schema.brand("Username"),
);

export type Username = typeof Username.Type;

/** A Stellar account address. Syntax only; the checksum is verified where the SDK is loaded. */
export const AccountAddress = Schema.String.check(Schema.isPattern(/^G[A-Z2-7]{55}$/)).pipe(
  Schema.brand("AccountAddress"),
);

export type AccountAddress = typeof AccountAddress.Type;

export class Profile extends Schema.Class<Profile>("@workspace/wallet/Profile")({
  username: Username,
  address: AccountAddress,
}) {}

// --- money --------------------------------------------------------------

/** USDC in base units: 1 USDC = 10_000_000. A bigint in memory, digits on the wire. */
export const Usdc = Schema.BigIntFromString.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: 9223372036854775807n }),
).pipe(Schema.brand("Usdc"));

export type Usdc = typeof Usdc.Type;

export const PositiveUsdc = Usdc.check(Schema.isGreaterThanBigInt(0n)).pipe(
  Schema.brand("PositiveUsdc"),
);

export type PositiveUsdc = typeof PositiveUsdc.Type;

/** "5", "5.5", "5.50" → base units. None when it is not a positive amount with ≤ 7 decimals. */
export function parseUsdc(text: string): Option.Option<PositiveUsdc> {
  if (!/^[0-9]+(?:\.[0-9]{1,7})?$/.test(text) || text.length > 32) return Option.none();

  const [whole = "0", fraction = ""] = text.split(".");

  return Schema.decodeOption(PositiveUsdc)(
    (BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, "0"))).toString(),
  );
}

export function formatUsdc(amount: Usdc): string {
  const fraction = (amount % 10000000n).toString().padStart(7, "0").replace(/0+$/, "");

  return `${amount / 10000000n}${fraction ? `.${fraction}` : ""}`;
}

// --- approval -----------------------------------------------------------

/** A transaction the server built and nobody has signed. Opaque outside `stellar/`. */
export const UnsignedEnvelope = Schema.String.pipe(Schema.brand("UnsignedEnvelope"));

export type UnsignedEnvelope = typeof UnsignedEnvelope.Type;

export class SigningRequest extends Schema.Class<SigningRequest>(
  "@workspace/wallet/SigningRequest",
)({
  envelope: UnsignedEnvelope,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

/** Each signing stage returns one signature and no envelope. */
export class Approval extends Schema.Class<Approval>("@workspace/wallet/Approval")({
  signature: Schema.Uint8ArrayFromBase64,
}) {}

export class InvalidAddress extends Schema.TaggedClass<InvalidAddress>()("InvalidAddress", {
  address: AccountAddress,
}) {}

export class NotSponsored extends Schema.TaggedClass<NotSponsored>()("NotSponsored", {}) {}

export class ExternalMemoRequired extends Schema.TaggedClass<ExternalMemoRequired>()(
  "ExternalMemoRequired",
  {},
) {}

// --- opening a wallet ---------------------------------------------------

export class WalletClaim extends Schema.Class<WalletClaim>("@workspace/wallet/WalletClaim")({
  username: Username,
  address: AccountAddress,
}) {}

export class OpeningDraft extends Schema.TaggedClass<OpeningDraft>()("OpeningDraft", {
  request: SigningRequest,
}) {}

export class RecoveryDraft extends Schema.TaggedClass<RecoveryDraft>()("RecoveryDraft", {
  request: SigningRequest,
}) {}

export class OpeningPending extends Schema.TaggedClass<OpeningPending>()("OpeningPending", {}) {}

export class Opened extends Schema.TaggedClass<Opened>()("Opened", { profile: Profile }) {}

export class UsernameTaken extends Schema.TaggedClass<UsernameTaken>()("UsernameTaken", {
  username: Username,
}) {}

export const OpenStep = Schema.Union([
  OpeningDraft,
  RecoveryDraft,
  OpeningPending,
  Opened,
  UsernameTaken,
  InvalidAddress,
  NotSponsored,
]);

export type OpenStep = typeof OpenStep.Type;

// --- transfers ----------------------------------------------------------

/** Minted on the phone with crypto.randomUUID() before any network call. */
export const TransferId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("TransferId"));

export type TransferId = typeof TransferId.Type;

// Recipient variants carry a username, phone or address; phone support is deferred.
export const UsernameRecipient = Schema.TaggedStruct("Username", { value: Username });
export const PhoneRecipient = Schema.TaggedStruct("Phone", { value: Schema.String });
export const AddressRecipient = Schema.TaggedStruct("Address", { value: AccountAddress });
export const Recipient = Schema.Union([UsernameRecipient, PhoneRecipient, AddressRecipient]);

export type Recipient = typeof Recipient.Type;

export class TransferOrder extends Schema.Class<TransferOrder>("@workspace/wallet/TransferOrder")({
  id: TransferId,
  from: AccountAddress,
  to: Recipient,
  amount: PositiveUsdc,
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
  amount: PositiveUsdc,
};

/** Signed, stored, on its way. It will become Settled or Failed without the phone. */
export class Pending extends Schema.TaggedClass<Pending>()("Pending", {
  ...transferFields,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

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
export class Reserved extends Schema.TaggedClass<Reserved>()("Reserved", transferFields) {}

export class Claimed extends Schema.TaggedClass<Claimed>()("Claimed", transferFields) {}

export class Refunded extends Schema.TaggedClass<Refunded>()("Refunded", transferFields) {}

export const Receipt = Schema.Union([Pending, Settled, Failed, Reserved, Claimed, Refunded]);

export type Receipt = typeof Receipt.Type;

export class TransferDraft extends Schema.TaggedClass<TransferDraft>()("TransferDraft", {
  request: SigningRequest,
  recipient: ResolvedRecipient,
}) {}

export class NotOpened extends Schema.TaggedClass<NotOpened>()("NotOpened", {}) {}

export class UnknownRecipient extends Schema.TaggedClass<UnknownRecipient>()("UnknownRecipient", {
  username: Username,
}) {}

export class PhoneNotSupported extends Schema.TaggedClass<PhoneNotSupported>()(
  "PhoneNotSupported",
  {},
) {}

export class InsufficientBalance extends Schema.TaggedClass<InsufficientBalance>()(
  "InsufficientBalance",
  { available: Usdc },
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
]);

export type TransferStep = typeof TransferStep.Type;

// --- overview -----------------------------------------------------------

export class Holding extends Schema.TaggedClass<Holding>()("Holding", {
  profile: Profile,
  balance: Usdc,
  latest: Schema.OptionFromNullOr(Receipt), // the sender's most recent transfer, any state
}) {}

export class NeedsReopening extends Schema.TaggedClass<NeedsReopening>()("NeedsReopening", {
  profile: Profile,
}) {}

export const Overview = Schema.Union([NotOpened, Holding, NeedsReopening, InvalidAddress]);

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
  // Later backup step: protect(enrollment, approval) and recover(assertion); see backup.md.
  transfer(
    order: TransferOrder,
    approval: Option.Option<Approval>,
  ): Effect.Effect<TransferStep, WalletUnavailable>;
}
