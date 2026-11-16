# Wallet on testnet: sketch

Design only. Bodies say `not implemented` (`notImplemented()`), are `declare`d, or are pseudocode. The facts behind every decision are in `ground.md`, and the decision record is in `rationale.md`.

## 1. Caller's view first

UI code needs four things: does this device have a wallet, create one, show balance and activity, and send. Everything below is derived from these call sites.

```ts
// apps/web/src/wallet.ts — the only wiring the app does on the client side
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Wallet } from "@workspace/wallet";
import { callWallet } from "@/server/wallet";

export const wallet = ManagedRuntime.make(Wallet.layer(callWallet));
```

```ts
// apps/web/src/server/wallet.ts — the single server function; the app's only server-side wiring
import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { env } from "cloudflare:workers";
import { walletCall, walletServerLayer } from "@workspace/wallet/server";
import { requestDatabaseLayer } from "./db";

const requestWalletLayer = Layer.suspend(() =>
  walletServerLayer({
    sponsorSecret: Redacted.make(env.ORCHID_SPONSOR_SECRET),
    rpcUrl: env.STELLAR_RPC_URL,
  }),
).pipe(Layer.provide(requestDatabaseLayer));

export const callWallet = createServerFn({ method: "POST" })
  .validator(walletCall.validator)
  .handler(({ data }) =>
    Effect.runPromise(walletCall.serve(data).pipe(Effect.provide(requestWalletLayer))),
  );
```

**Call site 1: gate wallet routes on a local key.** No network call, so first paint is instant on a slow phone.

```tsx
// apps/web/src/routes/_wallet.tsx
export const Route = createFileRoute("/_wallet")({
  ssr: false,
  beforeLoad: async () => {
    const profile = await wallet.runPromise(Wallet.use((w) => w.profile));
    if (Option.isNone(profile)) throw redirect({ to: "/welcome" });
    return { profile: profile.value };
  },
});
```

**Call site 2: create a wallet with a username.**

```tsx
// apps/web/src/routes/welcome.tsx (ssr: false)
const createWallet = (username: string) =>
  wallet.runPromise(
    Wallet.use((w) => w.create(username)).pipe(
      Effect.as(Option.none<string>()),
      Effect.catchTags({
        UsernameInvalid: () => Effect.succeed(Option.some(copy.usernameRules)),
        UsernameTaken: (e) => Effect.succeed(Option.some(copy.taken(e.username))),
        WalletOffline: () => Effect.succeed(Option.some(copy.offline)),
      }),
    ),
  );
```

**Call site 3: home, then review, then confirm.**

```tsx
// apps/web/src/routes/_wallet/index.tsx
loader: () => wallet.runPromise(Wallet.use((w) => w.overview)),
// component: formatUsdc(overview.available), overview.activity.map(row => <TransferRow transfer={row} />)

// apps/web/src/routes/_wallet/send.tsx
const review = (to: string, amount: string) => wallet.runPromiseExit(Wallet.use((w) => w.preview(to, amount)));
// screen shows draft.recipient.username and formatUsdc(draft.amount); the user taps "Yapear"
const confirm = (draft: TransferDraft) => wallet.runPromise(Wallet.use((w) => w.send(draft)));
// confirm resolves to a Transfer whose status is "sending" | "pending" | "sent" | "not_sent"
```

What the caller never sees: keys, XDR, sequence numbers, time bounds, sponsorship, fee bumps, RPC statuses, retries, the outbox, idempotency keys, or tables.

## 2. Candidates

Each candidate is a whole shape that runs from the device to the chain. All four keep the device as the only holder of the user's key.

### A. Relay: the device builds and signs; the server checks, pays the fee, submits and records

- The device builds the payment from a server quote (recipient address, sequence, deadline), signs it, and stores the signed envelope in a local outbox. It then sends the envelope to the server.
- The server checks the envelope against the transfer policy, fee-bumps it once, stores that exact envelope keyed by the inner transaction hash, submits it, and drives it to a result. It reconciles any row still pending whenever that row is read.
- Enrollment is the exception: the sponsor has to be the source, so the server builds that transaction and the device checks it before signing.
- Public surface: the device entry (the `Wallet` service with 5 members) and the server entry (`walletCall`, `walletServerLayer`).
- Red-flag screen:
  - Shallow: no. One call per user decision.
  - Leakage: each transaction layout lives in one shared file that has both the build half and the check half.
  - Temporal decomposition: no. Files are grouped by knowledge (enrollment, transfer, directory, chain).
  - Pass-through: only the single Start server function, which adds env and layer provisioning.
  - Split ownership: the outbox (device) holds an envelope only until the server acknowledges it. Status is written by the server only.
  - Two ways to do one task: no.
  - Importable internals: blocked by `exports` plus `*.server.ts`.
  - Hand-synced list: calls are listed once, and replies are keyed by `satisfies` and an exhaustive `Match`.
  - **Viable.**

### B. Direct: the device talks to Stellar RPC; the server only resolves usernames and co-signs

- The device fetches its sequence from RPC, builds and signs the transaction, asks the server to "co-sign" (sponsor signature or fee bump), submits to RPC itself, polls `getTransaction`, and reads activity from RPC.
- Postgres holds only usernames.
- Red-flag screen:
  - **Leakage**: the RPC URL, RPC status codes and result XDR parsing live on the device, while the policy check lives on the co-signer.
  - **Shallow server**: "co-sign" is a sign-this-blob method, and callers coordinate fetch-sequence, build, co-sign, submit and poll for one send.
  - **Two ways later**: pot refunds and payment links are server-originated, so they would need a second submit path.
  - History disappears after about 7 days of RPC retention, and again at each testnet reset.
  - The client bundle is heavier (`rpc` plus polling).
  - **Rejected.**

### C. Orchestrator: the server builds every transaction; the device is a checking signer

- The device calls `prepare(to, amount, idempotencyKey)`. The server stores an intent, builds the transaction and returns it. The device checks and signs it, and the server submits it.
- There is no device outbox: a signature that never reaches the server is simply never submitted.
- Red-flag screen:
  - Same surface depth as A.
  - Two round trips on every send.
  - The server gains an `awaiting_signature` state.
  - The device still needs the SDK to decode and check every server-built transaction.
  - The client-generated idempotency key duplicates what the inner transaction hash already gives.
  - **Viable, but costlier per send than A.**

### D. Smart account: a Soroban C-address with passkey signing and a relayer

- There is no trustline or sequence for the user, the signer is a passkey, and it is ready for agent accounts.
- Red-flag screen:
  - Not a red flag but a **product blocker**: a SAC `transfer` cannot carry a memo, only a muxed ID, so Lemon-style memo withdrawals break.
  - It adds contract deployment, simulation, a relayer and more stack.
  - The testnet reset on 2026-12-16 wipes deployed contracts.
  - **Rejected for now.** It stays possible later because no Stellar concept leaves the wallet package.

### Synthesis

Base: **A**.

- Grafted from C: the server drives every acknowledged transfer to a result and owns its status, so the device is not needed after acknowledgement. Enrollment also uses C's pattern: the server builds, the device checks and signs.
- Grafted from B: the chain is the only source of balances (no balance table), and the inner transaction hash is the idempotency key.
- Grafted from D: all Stellar types stay inside the package, so the account kind can change behind `Wallet`.

## 3. Module map

```
packages/wallet/                         "@workspace/wallet"
  package.json   exports: { ".": "./src/index.ts", "./server": "./src/server/index.server.ts" }
  src/
    index.ts                 device entry: Wallet, values, errors, formatUsdc, type WalletRelay
    values.ts                Username, Usdc, Address, TransferId, Envelope, Profile, Transfer, Overview, TransferDraft
    errors.ts                Schema.TaggedError classes shared by device and wire
    protocol.ts              the only list of calls and their replies
    stellar/
      network.ts             passphrase, USDC asset, deadline and fee policy (one place)
      enrollment-tx.ts       server builds, device checks: the enrollment sandwich
      transfer-tx.ts         device builds, server reads and checks: the payment
    device/
      wallet.ts              Wallet layer: create, overview, preview, send
      keystore.ts            IndexedDB: key + profile (only writer)
      outbox.ts              IndexedDB: unacknowledged envelope + last signed sequence (only writer)
      relay.ts               typed call over WalletRelay; maps transport failure to WalletOffline
    server/
      index.server.ts        server entry: walletCall, walletServerLayer
      serve.server.ts        exhaustive dispatch of WalletCall
      directory.server.ts    usernames to addresses (only writer of `wallets`)
      transfers.server.ts    submit + reconcile (only writer of `transfers`)
      sponsor.server.ts      the only holder of the sponsor secret: enrollment offers, fee bumps
      chain.server.ts        the only importer of @stellar/stellar-sdk/rpc
      tables.server.ts       Drizzle tables, not exported

apps/web/src/server/wallet.ts   callWallet server function (above)
apps/web/src/wallet.ts          ManagedRuntime (above)
apps/web/src/routes/...         UI only
```

How the boundaries are enforced:

- **Deep imports.** The `exports` map exposes only two entries, so `@workspace/wallet/src/...` fails module resolution in typecheck and in build. No `paths` alias may be added for this package; the existing `@workspace/ui/*` alias does bypass `exports`.
- **Server code in the client.** Every server file is named `*.server.ts`, so Start import protection fails `bun run build` if client code pulls one in. That includes `device/*` importing `server/*` by relative path.

New dependency: `@stellar/stellar-sdk@17.4.0` in `packages/wallet`. The device imports only `@stellar/stellar-sdk/base`, and only `chain.server.ts` imports `/rpc`. The package does not depend on `@tanstack/react-start`. No other stack is added, and IndexedDB is used directly with no wrapper library.

## 4. Types and signatures

### Values (`values.ts`)

The representation of each value is decided once, here.

```ts
import * as Schema from "effect/Schema";

/** Lowercase handle without "@". Parsed by `parseUsername`, never by callers. */
export const Username = Schema.String.check(Schema.isPattern(/^[a-z0-9_]{3,20}$/)).pipe(
  Schema.brand("Username"),
);
export type Username = typeof Username.Type;

/** USDC in 7-decimal ledger units (1 USDC = 10_000_000n). Encoded as a decimal string on the wire. */
export const Usdc = Schema.BigIntFromString.pipe(Schema.brand("Usdc"));
export type Usdc = typeof Usdc.Type;

/** Classic account strkey (G...). The checksum is checked with the SDK's StrKey inside the package. */
export const Address = Schema.String.check(Schema.isPattern(/^G[A-Z2-7]{55}$/)).pipe(
  Schema.brand("Address"),
);
export type Address = typeof Address.Type;

/** Inner transaction hash, hex. Also the idempotency key. */
export const TransferId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("TransferId"),
);
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
export const TransferStatus = Schema.Literals(["sending", "pending", "sent", "not_sent"]);

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
export class UsernameInvalid extends Schema.TaggedError<UsernameInvalid>()("UsernameInvalid", {
  input: Schema.String,
}) {}
export class UsernameTaken extends Schema.TaggedError<UsernameTaken>()("UsernameTaken", {
  username: Username,
}) {}
export class WalletExists extends Schema.TaggedError<WalletExists>()("WalletExists", {
  profile: Profile,
}) {}
export class NoWallet extends Schema.TaggedError<NoWallet>()("NoWallet", {}) {}
export class WalletOffline extends Schema.TaggedError<WalletOffline>()("WalletOffline", {}) {}
export class DeviceStorageFailed extends Schema.TaggedError<DeviceStorageFailed>()(
  "DeviceStorageFailed",
  {},
) {}
export class RecipientInvalid extends Schema.TaggedError<RecipientInvalid>()("RecipientInvalid", {
  username: Schema.String,
  reason: Schema.Literals(["unknown", "self"]),
}) {}
export class AmountInvalid extends Schema.TaggedError<AmountInvalid>()("AmountInvalid", {
  input: Schema.String,
}) {}
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { available: Usdc },
) {}
export class TransferInFlight extends Schema.TaggedError<TransferInFlight>()("TransferInFlight", {
  transfer: Transfer,
}) {}
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
      UsernameInvalid | UsernameTaken | WalletExists | WalletOffline | DeviceStorageFailed
    >;
    /** Delivers any transfer this device signed but Orchid has not acknowledged, then reads balance and activity. */
    readonly overview: Effect.Effect<Overview, NoWallet | WalletOffline>;
    /** Resolves the recipient and checks the amount against `available`. Nothing is signed. */
    readonly preview: (
      to: string,
      amount: string,
    ) => Effect.Effect<
      TransferDraft,
      NoWallet | RecipientInvalid | AmountInvalid | InsufficientFunds | WalletOffline
    >;
    /** Signs once and hands off. A network drop after signing is a status ("sending"), not an error. */
    readonly send: (
      draft: TransferDraft,
    ) => Effect.Effect<Transfer, NoWallet | TransferInFlight | WalletOffline | DeviceStorageFailed>;
  }
>()("@workspace/wallet/Wallet") {
  static readonly layer = (relay: WalletRelay): Layer.Layer<Wallet> => notImplemented();
}

/** The app's `callWallet` server function satisfies this; the package never imports the app. */
export type WalletRelay = (input: {
  readonly data: WalletCallEncoded;
}) => Promise<WalletReplyEncoded>;
```

### Wire protocol (`protocol.ts`, internal)

```ts
class BeginEnrollment extends Schema.TaggedClass<BeginEnrollment>()("BeginEnrollment", {
  username: Username,
  address: Address,
}) {}
class CompleteEnrollment extends Schema.TaggedClass<CompleteEnrollment>()("CompleteEnrollment", {
  envelope: Envelope,
}) {}
class ReadOverview extends Schema.TaggedClass<ReadOverview>()("ReadOverview", {
  address: Address,
}) {}
class QuoteTransfer extends Schema.TaggedClass<QuoteTransfer>()("QuoteTransfer", {
  from: Address,
  to: Username,
}) {}
class SubmitTransfer extends Schema.TaggedClass<SubmitTransfer>()("SubmitTransfer", {
  envelope: Envelope,
}) {}

export const WalletCall = Schema.Union([
  BeginEnrollment,
  CompleteEnrollment,
  ReadOverview,
  QuoteTransfer,
  SubmitTransfer,
]);
export type WalletCall = typeof WalletCall.Type;
export type WalletCallEncoded = typeof WalletCall.Encoded;

class EnrollmentOffer extends Schema.TaggedClass<EnrollmentOffer>()("EnrollmentOffer", {
  envelope: Envelope,
}) {}
/** Sequence and deadline come from the chain's clock, not the phone's clock. */
class Quote extends Schema.TaggedClass<Quote>()("Quote", {
  recipient: Profile,
  sequence: Schema.BigIntFromString, // current on-ledger sequence of `from`
  validUntil: Schema.DateTimeUtcFromString, // last ledger close + transfer timeout
  serverTime: Schema.DateTimeUtcFromString, // used for a skew-free "is this quote still fresh"
}) {}
class OverviewSnapshot extends Schema.TaggedClass<OverviewSnapshot>()("OverviewSnapshot", {
  profile: Profile,
  balance: Usdc,
  activity: Schema.Array(Transfer),
}) {}
class Receipt extends Schema.TaggedClass<Receipt>()("Receipt", { transfer: Transfer }) {}
class EnrollmentStale extends Schema.TaggedError<EnrollmentStale>()("EnrollmentStale", {}) {}
class NotEnrolled extends Schema.TaggedError<NotEnrolled>()("NotEnrolled", {}) {}
class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

/** Keyed by call tag. `satisfies` makes a missing or extra key a compile error, not a sync chore. */
export const walletReplies = {
  BeginEnrollment: Schema.Union([EnrollmentOffer, UsernameTaken, UsernameInvalid, Unavailable]),
  CompleteEnrollment: Schema.Union([Profile, EnrollmentStale, Unavailable]),
  ReadOverview: Schema.Union([OverviewSnapshot, NotEnrolled, Unavailable]),
  QuoteTransfer: Schema.Union([Quote, RecipientInvalid, NotEnrolled, Unavailable]),
  SubmitTransfer: Schema.Union([Receipt, Unavailable]),
} satisfies { readonly [Tag in WalletCall["_tag"]]: Schema.Top };

export type WalletReplyEncoded = (typeof walletReplies)[WalletCall["_tag"]]["Encoded"];
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
  readonly serve: (call: WalletCall) => Effect.Effect<WalletReplyEncoded, never, WalletServer>;
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
export declare function buildEnrollment(sponsor: Account, newcomer: Address): Transaction; // server
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
class TransferRejected extends Schema.TaggedError<TransferRejected>()("TransferRejected", {
  rule: Schema.String,
}) {}

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
    readonly reserve: (username: Username, address: Address) => Effect.Effect<void, UsernameTaken>;
    readonly activate: (address: Address) => Effect.Effect<Profile>;
    readonly resolve: (username: Username) => Effect.Effect<Option.Option<Profile>>; // active only
    readonly profileOf: (address: Address) => Effect.Effect<Option.Option<Profile>>;
  }
>()("@workspace/wallet/Directory") {}

class Sponsor extends Context.Service<
  Sponsor,
  {
    readonly offerEnrollment: (newcomer: Address) => Effect.Effect<Envelope, Unavailable>; // built + sponsor-signed
    readonly confirmEnrollment: (envelope: Envelope) => Effect.Effect<Envelope, EnrollmentTampered>; // same layout it offered, now co-signed
    readonly feeBump: (inner: TransferTx) => Envelope; // called once per transfer; result stored
  }
>()("@workspace/wallet/Sponsor") {}

class Chain extends Context.Service<
  Chain,
  {
    readonly balance: (address: Address) => Effect.Effect<Usdc, Unavailable>;
    readonly sequence: (address: Address) => Effect.Effect<bigint, Unavailable | NotEnrolled>;
    readonly clock: Effect.Effect<DateTime.Utc, Unavailable>; // latest ledger close time
    readonly submit: (
      envelope: Envelope,
    ) => Effect.Effect<"queued" | "busy" | "refused", Unavailable>;
    //   PENDING|DUPLICATE → "queued", TRY_AGAIN_LATER → "busy", ERROR → "refused" (never applied)
    readonly outcome: (
      id: TransferId,
      validUntil: DateTime.Utc,
    ) => Effect.Effect<"applied" | "failed" | "expired" | "unknown", Unavailable>;
    //   "expired" only when getTransaction is NOT_FOUND and latestLedgerCloseTime > validUntil
  }
>()("@workspace/wallet/Chain") {}

class Transfers extends Context.Service<
  Transfers,
  {
    readonly submit: (envelope: Envelope) => Effect.Effect<Transfer, Unavailable>;
    readonly activity: (address: Address) => Effect.Effect<ReadonlyArray<Transfer>, Unavailable>; // reconciles pending rows it returns
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

export const transferStatus = pgEnum("transfer_status", ["pending", "sent", "not_sent"]);
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

## 5. Flows (pseudocode)

**create(username)**

1. Parse the username, or fail with `UsernameInvalid`. If the keystore already has an active profile, fail with `WalletExists`.
2. Reuse the keystore's _pending_ key or generate `Keypair.random()`. Persist it **before** any network call, and call `navigator.storage.persist()`. A crash later therefore never orphans a reserved username behind a lost key.
3. `BeginEnrollment` → `EnrollmentOffer`. The server reserves the username for this address. Re-reserving from the same address is idempotent and moves an unactivated reservation. The server then builds the sandwich and signs it as sponsor.
4. `checkEnrollment(offer, me)`, then sign → `CompleteEnrollment`. The server checks the envelope again, submits it, and waits for the outcome.
   - If the account already exists with a sponsored USDC trustline, the server treats that as success: the crash happened after an earlier submit.
   - `EnrollmentStale` (the sponsor's sequence moved) means repeat from step 3, at most 3 times.
5. Mark the keystore profile active and return it.

**send(draft)** (the no-double-send core)

1. If the outbox holds an entry, deliver it first. If it is still unresolved, fail with `TransferInFlight(entry)`. **At most one unresolved envelope per account**, so two envelopes can never both apply.
2. If the draft's quote is fresher than `freshQuoteMarginSeconds`, measured against `serverTime` plus elapsed device time, use it. Otherwise send `QuoteTransfer` again. If offline here, fail with `WalletOffline`; nothing has been signed.
3. `sequence = max(quote.sequence, outbox.lastSigned) + 1`. Build, sign with `maxTime = quote.validUntil`.
4. `outbox.put(entry)`. **This is the commit point.** If the write fails, fail with `DeviceStorageFailed`; nothing was sent.
5. `SubmitTransfer`, retried with a bounded backoff.
   - On a receipt, `outbox.settle(id)` and return `receipt.transfer`.
   - On a transport failure, return the transfer with status `"sending"`. The next `overview` or `send` redelivers the same bytes.

**Server: SubmitTransfer(envelope)**

1. `id = hash(inner)`. If a row with this id exists, go to step 5. This is idempotency by content, not by a client token.
2. `readTransfer`, which checks policy (`TransferRejected` means the receipt is `not_sent`, and nothing is stored). Both parties must be active in `Directory`.
3. If `now > validUntil`, ask `Chain.outcome`. If it is not applied, the receipt is `not_sent` and nothing is submitted.
4. Insert the row with `pending` and `envelope = Sponsor.feeBump(inner)` (`onConflictDoNothing`, then re-read).
5. If the row is `pending`, `Chain.submit(row.envelope)`, the same bytes every time. Then poll `Chain.outcome` a bounded number of times, about 2 ledgers. Update the row with `WHERE status = 'pending'`, so concurrent reconcilers converge.
6. Return a `Receipt` with the row as a `Transfer`.

**overview**

1. Deliver the outbox (best effort).
2. `ReadOverview(address)`. The server reads `Chain.balance` and `Transfers.activity`, which reconciles the pending rows it returns.
3. Merge in the local `"sending"` entry. `available = balance − Σ outgoing sending | pending`.

## 6. Invariants and where they live

| Invariant                                 | Enforced by                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The key never leaves the device           | Only `device/keystore.ts` touches it. Wallet routes are `ssr: false`.                                 |
| What the user saw is what gets signed     | `TransferDraft` can only be built by `preview` (sealed quote). Usernames are permanent once active.   |
| At most one send per confirmation         | Sequence numbers, plus one unresolved envelope per account (`outbox`), plus a fixed `maxTime`         |
| Retrying never creates a second payment   | Every retry submits the same signed bytes. The server keys on the inner hash and stores one fee bump. |
| "not_sent" is a fact, not a guess         | Only `Chain.outcome` after a ledger closes past `validUntil`, or a terminal on-ledger failure         |
| One writer per state                      | `wallets` → Directory. `transfers` → Transfers. Outbox and keystore → their device modules.           |
| Orchid only pays fees for wallet payments | `readTransfer` policy before `Sponsor.feeBump`. `checkEnrollment` before the device signs.            |
| Amounts are never floats                  | `Usdc` is a branded bigint in ledger units. Parsing and formatting happen only in `values.ts`.        |
