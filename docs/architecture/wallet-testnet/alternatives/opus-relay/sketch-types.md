# Sketch: types and signatures

Part of the [sketch index](sketch.md). Illustrative signatures for values, errors, the device entry, the wire protocol, server internals and tables.

## 4. Types and signatures

### Values (`values.ts`)

The representation of each value is decided once, here.

```ts
import * as Schema from "effect/Schema";

/** Lowercase handle without "@". Parsed by `parseUsername`, never by callers. */
export const Username = Schema.String.check(
  Schema.isPattern(/^[a-z0-9_]{3,20}$/),
).pipe(Schema.brand("Username"));
export type Username = typeof Username.Type;

/** USDC in 7-decimal ledger units (1 USDC = 10_000_000n). Encoded as a decimal string on the wire. */
export const Usdc = Schema.BigIntFromString.pipe(Schema.brand("Usdc"));
export type Usdc = typeof Usdc.Type;

/** Classic account strkey (G...). The checksum is checked with the SDK's StrKey inside the package. */
export const Address = Schema.String.check(
  Schema.isPattern(/^G[A-Z2-7]{55}$/),
).pipe(Schema.brand("Address"));
export type Address = typeof Address.Type;

/** Inner transaction hash, hex. Also the idempotency key. */
export const TransferId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
).pipe(Schema.brand("TransferId"));
export type TransferId = typeof TransferId.Type;

/** Base64 transaction envelope XDR. Never exported from the device entry. */
export const Envelope = Schema.String.pipe(Schema.brand("Envelope"));
export type Envelope = typeof Envelope.Type;

export class Profile extends Schema.Class<Profile>("Profile")({
  username: Username,
  address: Address,
}) {}

/** "sending": signed and held only by this device. "pending": held by Orchid, not final.
 *  "sent": applied on-ledger. "not_sent": can never apply; no money moved. */
export const TransferStatus = Schema.Literals([
  "sending",
  "pending",
  "sent",
  "not_sent",
]);

export class Transfer extends Schema.Class<Transfer>("Transfer")({
  id: TransferId,
  direction: Schema.Literals(["in", "out"]),
  counterparty: Username,
  amount: Usdc,
  status: TransferStatus,
  at: Schema.DateTimeUtcFromString,
}) {}

export interface Overview {
  readonly profile: Profile;
  /** On-ledger trustline balance. */
  readonly balance: Usdc;
  /** balance minus outgoing transfers that are "sending" or "pending". */
  readonly available: Usdc;
  /** Newest first. Includes this device's unacknowledged transfer, if any. */
  readonly activity: ReadonlyArray<Transfer>;
}

declare const sealedQuote: unique symbol;

/** Built only by `Wallet.preview`. Binds what the user saw (recipient, amount) to what will be signed. */
export interface TransferDraft {
  readonly recipient: Profile;
  readonly amount: Usdc;
  readonly [sealedQuote]: Quote; // not constructible outside the package
}

export declare function formatUsdc(amount: Usdc): string; // "12.50"; display rounding lives here only
```

### Errors (`errors.ts`)

Errors are schema-backed, so the same classes cross the wire. `WalletOffline` always means **nothing irreversible happened**.

```ts
export class UsernameInvalid extends Schema.TaggedError<UsernameInvalid>()(
  "UsernameInvalid",
  {
    input: Schema.String,
  },
) {}
export class UsernameTaken extends Schema.TaggedError<UsernameTaken>()(
  "UsernameTaken",
  {
    username: Username,
  },
) {}
export class WalletExists extends Schema.TaggedError<WalletExists>()(
  "WalletExists",
  {
    profile: Profile,
  },
) {}
export class NoWallet extends Schema.TaggedError<NoWallet>()("NoWallet", {}) {}
export class WalletOffline extends Schema.TaggedError<WalletOffline>()(
  "WalletOffline",
  {},
) {}
export class DeviceStorageFailed extends Schema.TaggedError<DeviceStorageFailed>()(
  "DeviceStorageFailed",
  {},
) {}
export class RecipientInvalid extends Schema.TaggedError<RecipientInvalid>()(
  "RecipientInvalid",
  {
    username: Schema.String,
    reason: Schema.Literals(["unknown", "self"]),
  },
) {}
export class AmountInvalid extends Schema.TaggedError<AmountInvalid>()(
  "AmountInvalid",
  {
    input: Schema.String,
  },
) {}
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { available: Usdc },
) {}
export class TransferInFlight extends Schema.TaggedError<TransferInFlight>()(
  "TransferInFlight",
  {
    transfer: Transfer,
  },
) {}
```

### Device entry (`index.ts`, `device/wallet.ts`)

```ts
export class Wallet extends Context.Service<
  Wallet,
  {
    /** Local only, with no network call: the profile enrolled on this device. */
    readonly profile: Effect.Effect<Option.Option<Profile>>;
    /** Generates the key on the device, reserves the username, creates the sponsored account with a USDC trustline. */
    readonly create: (
      username: string,
    ) => Effect.Effect<
      Profile,
      | UsernameInvalid
      | UsernameTaken
      | WalletExists
      | WalletOffline
      | DeviceStorageFailed
    >;
    /** Delivers any transfer this device signed but Orchid has not acknowledged, then reads balance and activity. */
    readonly overview: Effect.Effect<Overview, NoWallet | WalletOffline>;
    /** Resolves the recipient and checks the amount against `available`. Nothing is signed. */
    readonly preview: (
      to: string,
      amount: string,
    ) => Effect.Effect<
      TransferDraft,
      | NoWallet
      | RecipientInvalid
      | AmountInvalid
      | InsufficientFunds
      | WalletOffline
    >;
    /** Signs once and hands off. A network drop after signing is a status ("sending"), not an error. */
    readonly send: (
      draft: TransferDraft,
    ) => Effect.Effect<
      Transfer,
      NoWallet | TransferInFlight | WalletOffline | DeviceStorageFailed
    >;
  }
>()("@workspace/wallet/Wallet") {
  static readonly layer = (relay: WalletRelay): Layer.Layer<Wallet> =>
    notImplemented();
}

/** The app's `callWallet` server function satisfies this; the package never imports the app. */
export type WalletRelay = (input: {
  readonly data: WalletCallEncoded;
}) => Promise<WalletReplyEncoded>;
```

### Wire protocol (`protocol.ts`, internal)

```ts
class BeginEnrollment extends Schema.TaggedClass<BeginEnrollment>()(
  "BeginEnrollment",
  {
    username: Username,
    address: Address,
  },
) {}
class CompleteEnrollment extends Schema.TaggedClass<CompleteEnrollment>()(
  "CompleteEnrollment",
  {
    envelope: Envelope,
  },
) {}
class ReadOverview extends Schema.TaggedClass<ReadOverview>()("ReadOverview", {
  address: Address,
}) {}
class QuoteTransfer extends Schema.TaggedClass<QuoteTransfer>()(
  "QuoteTransfer",
  {
    from: Address,
    to: Username,
  },
) {}
class SubmitTransfer extends Schema.TaggedClass<SubmitTransfer>()(
  "SubmitTransfer",
  {
    envelope: Envelope,
  },
) {}

export const WalletCall = Schema.Union([
  BeginEnrollment,
  CompleteEnrollment,
  ReadOverview,
  QuoteTransfer,
  SubmitTransfer,
]);
export type WalletCall = typeof WalletCall.Type;
export type WalletCallEncoded = typeof WalletCall.Encoded;

class EnrollmentOffer extends Schema.TaggedClass<EnrollmentOffer>()(
  "EnrollmentOffer",
  {
    envelope: Envelope,
  },
) {}
/** Sequence and deadline come from the chain's clock, not the phone's clock. */
class Quote extends Schema.TaggedClass<Quote>()("Quote", {
  recipient: Profile,
  sequence: Schema.BigIntFromString, // current on-ledger sequence of `from`
  validUntil: Schema.DateTimeUtcFromString, // last ledger close + transfer timeout
  serverTime: Schema.DateTimeUtcFromString, // used for a skew-free "is this quote still fresh"
}) {}
class OverviewSnapshot extends Schema.TaggedClass<OverviewSnapshot>()(
  "OverviewSnapshot",
  {
    profile: Profile,
    balance: Usdc,
    activity: Schema.Array(Transfer),
  },
) {}
class Receipt extends Schema.TaggedClass<Receipt>()("Receipt", {
  transfer: Transfer,
}) {}
class EnrollmentStale extends Schema.TaggedError<EnrollmentStale>()(
  "EnrollmentStale",
  {},
) {}
class NotEnrolled extends Schema.TaggedError<NotEnrolled>()(
  "NotEnrolled",
  {},
) {}
class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  {},
) {}

/** Keyed by call tag. `satisfies` makes a missing or extra key a compile error, not a sync chore. */
export const walletReplies = {
  BeginEnrollment: Schema.Union([
    EnrollmentOffer,
    UsernameTaken,
    UsernameInvalid,
    Unavailable,
  ]),
  CompleteEnrollment: Schema.Union([Profile, EnrollmentStale, Unavailable]),
  ReadOverview: Schema.Union([OverviewSnapshot, NotEnrolled, Unavailable]),
  QuoteTransfer: Schema.Union([
    Quote,
    RecipientInvalid,
    NotEnrolled,
    Unavailable,
  ]),
  SubmitTransfer: Schema.Union([Receipt, Unavailable]),
} satisfies { readonly [Tag in WalletCall["_tag"]]: Schema.Top };

export type WalletReplyEncoded =
  (typeof walletReplies)[WalletCall["_tag"]]["Encoded"];
```

### Server entry (`server/index.server.ts`)

```ts
export interface WalletServerConfig {
  readonly sponsorSecret: Redacted.Redacted<string>;
  readonly rpcUrl: string;
}

/** Opaque to the app: it only provides it. */
export class WalletServer extends Context.Service<
  WalletServer,
  { readonly serve: (call: WalletCall) => Effect.Effect<WalletReplyEncoded> }
>()("@workspace/wallet/WalletServer") {}

export declare const walletServerLayer: (
  config: WalletServerConfig,
) => Layer.Layer<WalletServer, never, PgClient.PgClient>;

export declare const walletCall: {
  readonly validator: StandardSchemaV1<WalletCallEncoded, WalletCall>; // Schema.toStandardSchemaV1(WalletCall)
  readonly serve: (
    call: WalletCall,
  ) => Effect.Effect<WalletReplyEncoded, never, WalletServer>;
};
```

`serve` never fails. Domain outcomes are reply values. Infrastructure failures (`SqlError`, RPC down) become `Unavailable` _before_ anything irreversible happens. After a transfer row exists they become a `pending` receipt.

### Shared Stellar knowledge (`stellar/*`, internal)

```ts
// network.ts — the only place these decisions live
export declare const network: {
  readonly passphrase: "Test SDF Network ; September 2015";
  readonly usdc: Asset; // USDC : GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
  readonly transferTimeoutSeconds: 60;
  readonly freshQuoteMarginSeconds: 20;
  readonly maxFeeBumpStroops: bigint;
};

// enrollment-tx.ts — the layout of one transaction, both halves
export declare function buildEnrollment(
  sponsor: Account,
  newcomer: Address,
): Transaction; // server
//   source = sponsor; ops: beginSponsoringFutureReserves(newcomer) [sponsor],
//   createAccount(newcomer, "0") [sponsor], changeTrust(USDC) [source: newcomer],
//   endSponsoringFutureReserves [source: newcomer]; setTimeout(transferTimeoutSeconds)
export declare function checkEnrollment(
  envelope: Envelope,
  me: Address,
): Effect.Effect<Transaction, EnrollmentTampered>; // device
//   rejects if any operation sourced from `me` is not exactly changeTrust(USDC) or endSponsoring,
//   or if createAccount's starting balance or destination differ

// internal-only results (never exported from either entry)
interface TransferTx {
  readonly id: TransferId;
  readonly from: Address;
  readonly to: Address;
  readonly amount: Usdc;
  readonly sequence: bigint;
  readonly validUntil: DateTime.Utc;
  readonly inner: Transaction;
}
interface SignedTransfer {
  readonly id: TransferId;
  readonly envelope: Envelope;
  readonly sequence: bigint;
  readonly validUntil: DateTime.Utc;
}
class EnrollmentTampered extends Schema.TaggedError<EnrollmentTampered>()(
  "EnrollmentTampered",
  {},
) {} // a defect on the device: never sign
class TransferRejected extends Schema.TaggedError<TransferRejected>()(
  "TransferRejected",
  {
    rule: Schema.String,
  },
) {}

// transfer-tx.ts
export declare function buildTransfer(
  quote: Quote,
  amount: Usdc,
  sequence: bigint,
  signer: Keypair,
): SignedTransfer; // device
export declare function readTransfer(
  envelope: Envelope,
): Effect.Effect<TransferTx, TransferRejected>; // server
//   exactly one payment op, asset USDC, no memo, source and destination distinct,
//   signature by source valid over hash(network.passphrase), maxTime present and ≤ now + timeout + slack
```

### Server internals (`server/*.server.ts`)

```ts
class Directory extends Context.Service<
  Directory,
  {
    readonly reserve: (
      username: Username,
      address: Address,
    ) => Effect.Effect<void, UsernameTaken>;
    readonly activate: (address: Address) => Effect.Effect<Profile>;
    readonly resolve: (
      username: Username,
    ) => Effect.Effect<Option.Option<Profile>>; // active only
    readonly profileOf: (
      address: Address,
    ) => Effect.Effect<Option.Option<Profile>>;
  }
>()("@workspace/wallet/Directory") {}

class Sponsor extends Context.Service<
  Sponsor,
  {
    readonly offerEnrollment: (
      newcomer: Address,
    ) => Effect.Effect<Envelope, Unavailable>; // built + sponsor-signed
    readonly confirmEnrollment: (
      envelope: Envelope,
    ) => Effect.Effect<Envelope, EnrollmentTampered>; // same layout it offered, now co-signed
    readonly feeBump: (inner: TransferTx) => Envelope; // called once per transfer; result stored
  }
>()("@workspace/wallet/Sponsor") {}

class Chain extends Context.Service<
  Chain,
  {
    readonly balance: (address: Address) => Effect.Effect<Usdc, Unavailable>;
    readonly sequence: (
      address: Address,
    ) => Effect.Effect<bigint, Unavailable | NotEnrolled>;
    readonly clock: Effect.Effect<DateTime.Utc, Unavailable>; // latest ledger close time
    readonly submit: (
      envelope: Envelope,
    ) => Effect.Effect<"queued" | "busy" | "refused", Unavailable>;
    //   PENDING|DUPLICATE → "queued", TRY_AGAIN_LATER → "busy", ERROR → "refused" (never applied)
    readonly outcome: (
      id: TransferId,
      validUntil: DateTime.Utc,
    ) => Effect.Effect<
      "applied" | "failed" | "expired" | "unknown",
      Unavailable
    >;
    //   "expired" only when getTransaction is NOT_FOUND and latestLedgerCloseTime > validUntil
  }
>()("@workspace/wallet/Chain") {}

class Transfers extends Context.Service<
  Transfers,
  {
    readonly submit: (
      envelope: Envelope,
    ) => Effect.Effect<Transfer, Unavailable>;
    readonly activity: (
      address: Address,
    ) => Effect.Effect<ReadonlyArray<Transfer>, Unavailable>; // reconciles pending rows it returns
  }
>()("@workspace/wallet/Transfers") {}
```

### Tables (`server/tables.server.ts`)

```ts
export const walletStatus = pgEnum("wallet_status", ["enrolling", "active"]);
export const wallets = pgTable("wallets", {
  username: text().primaryKey(), // permanent once active
  address: text().notNull().unique(),
  status: walletStatus().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const transferStatus = pgEnum("transfer_status", [
  "pending",
  "sent",
  "not_sent",
]);
export const transfers = pgTable("transfers", {
  id: text().primaryKey(), // inner tx hash = idempotency key
  sender: text().notNull(),
  recipient: text().notNull(),
  amount: bigint({ mode: "bigint" }).notNull(),
  sequence: bigint({ mode: "bigint" }).notNull(),
  validUntil: timestamp({ withTimezone: true }).notNull(),
  envelope: text().notNull(), // the fee-bumped envelope, built once and resubmitted byte-for-byte
  status: transferStatus().notNull(),
  ledger: integer(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp({ withTimezone: true }),
});
// indexes: (sender, created_at desc), (recipient, created_at desc)
```
