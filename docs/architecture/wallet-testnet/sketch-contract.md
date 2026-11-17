# Sketch: contract and device entry

Part of the [core wallet flow sketch](sketch.md). The shared schemas, the port, and the device-facing entry.

## 4. The contract

`@workspace/wallet`. It imports only `effect/Schema`, so it is safe in the first-load bundle.

```ts
import * as Schema from "effect/Schema";

// --- identity -----------------------------------------------------------

/** Lowercase, 3 to 20 of a–z 0–9 underscore. The "@" is display only. */
export const Username = Schema.String.check(
  Schema.isPattern(/^[a-z0-9_]{3,20}$/),
).pipe(Schema.brand("Username"));
export type Username = typeof Username.Type;

/** A Stellar account address. Syntax only; the checksum is verified where the SDK is loaded. */
export const AccountAddress = Schema.String.check(
  Schema.isPattern(/^G[A-Z2-7]{55}$/),
).pipe(Schema.brand("AccountAddress"));
export type AccountAddress = typeof AccountAddress.Type;

export class Profile extends Schema.Class<Profile>("@workspace/wallet/Profile")(
  {
    username: Username,
    address: AccountAddress,
  },
) {}

// --- money --------------------------------------------------------------

/** USDC in base units: 1 USDC = 10_000_000. A bigint in memory, digits on the wire. */
export const Usdc = Schema.BigIntFromString.check(
  /* 0 ≤ units ≤ int64 max */
).pipe(Schema.brand("Usdc"));
export type Usdc = typeof Usdc.Type;

export const PositiveUsdc = Usdc.check(/* units > 0 */).pipe(
  Schema.brand("PositiveUsdc"),
);
export type PositiveUsdc = typeof PositiveUsdc.Type;

/** "5", "5.5", "5.50" → base units. None when it is not a positive amount with ≤ 7 decimals. */
export declare function parseUsdc(text: string): Option.Option<PositiveUsdc>;
export declare function formatUsdc(amount: Usdc): string;

// --- approval -----------------------------------------------------------

/** A transaction the server built and nobody has signed. Opaque outside `stellar/`. */
export const UnsignedEnvelope = Schema.String.pipe(
  Schema.brand("UnsignedEnvelope"),
);
export type UnsignedEnvelope = typeof UnsignedEnvelope.Type;

export class SigningRequest extends Schema.Class<SigningRequest>(
  "@workspace/wallet/SigningRequest",
)({
  envelope: UnsignedEnvelope,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

/** Each signing stage returns one signature and no envelope. */
export class Approval extends Schema.Class<Approval>(
  "@workspace/wallet/Approval",
)({
  signature: Schema.Uint8ArrayFromBase64,
}) {}

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
/** This address is already bound to another username. */
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
]);
export type OpenStep = typeof OpenStep.Type;

// --- transfers ----------------------------------------------------------

/** Minted on the phone with crypto.randomUUID() before any network call. */
export const TransferId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("TransferId"),
);
export type TransferId = typeof TransferId.Type;

// Recipient variants carry a username, phone or address; phone support is deferred.
export const Recipient = Schema.Union([
  Schema.TaggedStruct("Username", { value: Username }),
  Schema.TaggedStruct("Phone", { value: Schema.String }),
  Schema.TaggedStruct("Address", { value: AccountAddress }),
]);

export class TransferOrder extends Schema.Class<TransferOrder>(
  "@workspace/wallet/TransferOrder",
)({
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
    /** True only for a known memo-requiring exchange address; false is not a completeness claim. */
    memoRequired: Schema.Boolean,
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
  InsufficientBalance,
  SenderBusy,
]);
export type TransferStep = typeof TransferStep.Type;

// --- overview -----------------------------------------------------------

export class Holding extends Schema.TaggedClass<Holding>()("Holding", {
  profile: Profile,
  balance: Usdc,
  latest: Schema.OptionFromNullOr(Receipt), // the sender's most recent transfer, any state
}) {}

export class NeedsReopening extends Schema.TaggedClass<NeedsReopening>()(
  "NeedsReopening",
  {
    profile: Profile,
  },
) {}

export const Overview = Schema.Union([NotOpened, Holding, NeedsReopening]);
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
```

In the later backup step, `WalletPort` gains replayable `protect` and `recover` operations and their transports. Their flows are described in `backup.md` sections 5 and 8; their concrete schemas are pending and are not implemented in this step.

Two rules are visible in these types.

**Refusals are values; breakdowns are errors.** "Username taken" and "insufficient balance" are answers, so they are members of the step unions and the UI must handle each one. A dead database or an unreachable network is the single error `WalletUnavailable`, which means only "unknown, ask again".

**`open` and `transfer` are replayable.** Calling either again with the same arguments returns the current step. That one property replaces separate prepare, submit, status and retry calls. The caller's whole protocol is: call; if the answer is a draft, approve it and call again with the approval; otherwise the answer is final or pending.

## 5. The device entry

`@workspace/wallet` root entry. Browser client exports are browser only.

```ts
export class NoWallet extends Schema.TaggedClass<NoWallet>()("NoWallet", {}) {}
export class Offline extends Schema.TaggedClass<Offline>()("Offline", {}) {}
export class InvalidUsername extends Schema.TaggedClass<InvalidUsername>()(
  "InvalidUsername",
  {},
) {}
export class InvalidRecipient extends Schema.TaggedClass<InvalidRecipient>()(
  "InvalidRecipient",
  {},
) {}
export class InvalidAmount extends Schema.TaggedClass<InvalidAmount>()(
  "InvalidAmount",
  {},
) {}
export class UnsupportedDevice extends Schema.TaggedClass<UnsupportedDevice>()(
  "UnsupportedDevice",
  {},
) {}
/** The server's transaction did not do exactly what was asked. Nothing was signed. */
export class DraftRejected extends Schema.TaggedClass<DraftRejected>()(
  "DraftRejected",
  {},
) {}

export type DeviceOverview = Holding | NeedsReopening | NoWallet | Offline;
export type CreateOutcome =
  | Opened
  | UsernameTaken
  | AddressBound
  | InvalidUsername
  | UnsupportedDevice
  | DraftRejected
  | Offline;
export type SendOutcome =
  | Settled
  | Pending
  | Failed
  | SenderBusy
  | InsufficientBalance
  | UnknownRecipient
  | InvalidRecipient
  | InvalidAmount
  | NoWallet
  | DraftRejected
  | Offline;

/** What the UI holds. Promises that never reject: this is the edge of the Effect world. */
export interface WalletClient {
  overview(): Promise<DeviceOverview>;
  create(usernameText: string): Promise<CreateOutcome>;
  send(recipientText: string, amountText: string): Promise<SendOutcome>;
}

export declare function connectWallet(port: WalletPort): WalletClient;
```

Internal to the entry:

```ts
// device/Keyring.ts — not exported from the package

class ExpectOpening extends Schema.TaggedClass<ExpectOpening>()(
  "ExpectOpening",
  {
    address: AccountAddress,
  },
) {}
class ExpectPayment extends Schema.TaggedClass<ExpectPayment>()(
  "ExpectPayment",
  {
    from: AccountAddress,
    to: AccountAddress,
    amount: PositiveUsdc,
  },
) {}
type Expectation = ExpectOpening | ExpectPayment;

class KeyringUnavailable extends Schema.TaggedError<KeyringUnavailable>()(
  "KeyringUnavailable",
  {
    cause: Schema.Defect(),
  },
) {}

class Keyring extends Context.Service<
  Keyring,
  {
    /** None until a key exists on this device. */
    readonly address: Effect.Effect<
      Option.Option<AccountAddress>,
      KeyringUnavailable
    >;
    /** Creates the key if there is none. Returns the same address every time after. */
    readonly enroll: Effect.Effect<AccountAddress, KeyringUnavailable>;
    /** The only path to a signature. Fails unless the envelope is exactly what is expected. */
    approve(
      request: SigningRequest,
      expected: Expectation,
    ): Effect.Effect<Approval, DraftRejected | KeyringUnavailable>;
  }
>()("@workspace/wallet/device/Keyring") {
  static readonly layer: Layer.Layer<Keyring> = Layer.effect(
    Keyring,
    Effect.die("not implemented"),
    // key: a non-extractable Ed25519 CryptoKey kept in IndexedDB
    // signing: effect/crypto Signature on WebCrypto
    // approve: lazy-load stellar/envelopes, readEnvelope, compare, then sign
  );
}
```

There is no `sign(bytes)` anywhere. A caller cannot obtain a signature without passing through the check, because the check and the key are in the same private module.

```ts
// device/client.ts — pseudocode for send

send(recipientText, amountText):
  to      = decode Username from recipientText (strip "@", lowercase)  else InvalidRecipient
  amount  = parseUsdc(amountText)                                      else InvalidAmount
  from    = keyring.address                                            else NoWallet
  order   = TransferOrder { id: crypto.randomUUID(), from, to, amount }   // lives only in this call

  step = port.transfer(order, none)              // retried on WalletUnavailable: same order, same answer
  if step is TransferDraft:
    approval = keyring.approve(step.request, ExpectPayment { from, to: step.recipient.address, amount })
    step = port.transfer(order, some(approval))  // retried on WalletUnavailable: same order, same answer
  if step is TransferDraft again:                // the first draft expired before the approval arrived
    approve and call once more, then stop

  while step is Pending and the polling budget is not spent:
    wait, then step = port.transfer(order, none)

  return step                                    // WalletUnavailable after retries → Offline
```

The order id exists only inside one `send` call. If the app dies, the id is gone and no later code can sign for it. What the server already holds is found again through `overview`.
