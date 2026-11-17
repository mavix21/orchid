import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { OpeningFacts, PaymentFacts, RecoveryFacts } from "../stellar/envelopes";
import type {
  Approval,
  InvalidAddress,
  NotSponsored,
  ExternalMemoRequired,
  MemoNotAllowed,
  PaymentMemo,
  Holding,
  NeedsReopening,
  Opened,
  UsernameTaken,
  Settled,
  Pending,
  Failed,
  SenderBusy,
  InsufficientBalance,
  UnknownRecipient,
  PhoneNotSupported,
  SigningRequest,
  WalletUnavailable,
} from "../contract";

/** The later device implementation verifies the expected facts before signing. */
export interface DeviceSigner {
  approve(
    request: SigningRequest,
    expected: OpeningFacts | PaymentFacts | RecoveryFacts,
  ): Effect.Effect<Approval, WalletUnavailable>;
}

export class NoWallet extends Schema.TaggedClass<NoWallet>()("NoWallet", {}) {}

export class Offline extends Schema.TaggedClass<Offline>()("Offline", {}) {}

export class InvalidUsername extends Schema.TaggedClass<InvalidUsername>()("InvalidUsername", {}) {}

export class InvalidRecipient extends Schema.TaggedClass<InvalidRecipient>()(
  "InvalidRecipient",
  {},
) {}

export class InvalidAmount extends Schema.TaggedClass<InvalidAmount>()("InvalidAmount", {}) {}

export class UnsupportedDevice extends Schema.TaggedClass<UnsupportedDevice>()(
  "UnsupportedDevice",
  {},
) {}

/** The server's transaction did not do exactly what was asked. Nothing was signed. */
export class DraftRejected extends Schema.TaggedClass<DraftRejected>()("DraftRejected", {}) {}

export type DeviceOverview = Holding | NeedsReopening | InvalidAddress | NoWallet | Offline;

export type CreateOutcome =
  | InvalidAddress
  | NotSponsored
  | Opened
  | UsernameTaken
  | InvalidUsername
  | UnsupportedDevice
  | DraftRejected
  | Offline;

export type SendOutcome =
  | InvalidAddress
  | ExternalMemoRequired
  | MemoNotAllowed
  | PhoneNotSupported
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
  send(recipientText: string, amountText: string, memo?: PaymentMemo): Promise<SendOutcome>;
}
