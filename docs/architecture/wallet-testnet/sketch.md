# Sketch: core wallet flow on testnet

Design only. Bodies are `not implemented` or pseudocode. Facts this rests on are in `ground.md`; the reasons for the choice are in `rationale.md`.

## Approved implementation scope (2026-11-16)

These owner-approved decisions take precedence over the illustrative service signatures and flow pseudocode below.

- This step implements `overview`, `open`, `transfer` and the scheduled sweep. Passkey backup, `protect`, `recover` and the enrollment envelope layout belong to the later backup step; do not add working-looking stubs. `readEnvelope` accepts only opening, payment and abandoned-account recovery layouts in this step.
- Opening uses two signing stages behind one user action. `OpeningDraft` carries the opening request; submit it first. Once the account exists, build a recovery request from its confirmed sequence and return `RecoveryDraft`. Both stages use `Approval` (one signature, no envelope) and the same replayable `open`. The recovery transaction has the user as source, sequence current + 1, `minTime` and `maxTime`, then exactly USDC `changeTrust` limit 0 and `accountMerge` to the reserve sponsor. Validate its layout and signature and store it unsubmitted before returning `Opened`. The sweep checks balance and sequence before recovery submission and marks a merged wallet `recovered`.
- An account that exists but lacks signed recovery stays `opening`. A later app session resumes `open` and requests that signature. If the device never returns, its reserve remains locked; this limitation is accepted. No background service can supply the missing signature.
- A resolved transfer recipient is either an Orchid `Profile` (username and address) or an external address without a username. Drafts, stored transfers and receipts retain that resolved recipient. `transfers.recipient` is nullable for external addresses; their destination address must still be stored. `Phone` resolves to a typed not-supported-yet outcome; no phone implementation is added.

## 1. Three candidates

Each candidate is a whole design, starting from what the UI calls.

### A. Server ledger

The server keeps a durable record of every transfer and is the only thing that talks to Stellar. The phone holds the key and nothing else.

```ts
// UI
const outcome = await wallet.send("@maria", "5.00");
```

Behind that call, the phone asks the server for a transaction, checks that it does what the user asked, signs it, and hands the signature back. The server wraps it so the sponsor pays the fee, stores it, submits it and follows it to its end. If the app closes after the signature is handed over, the server finishes alone.

### B. Device outbox

The phone builds, signs and submits transactions itself, straight to Stellar. It keeps a durable outbox in IndexedDB. The server is a username directory plus a co-signer for sponsorship and fees.

```ts
// UI
const outcome = await wallet.send("@maria", "5.00");
// inside: directory.resolve → build → sponsor.cosign(envelope) → outbox.put → rpc.send → rpc.poll
```

The server stores no transfers. History comes from the chain.

### C. Contract account

Each wallet is a smart contract controlled by a passkey. A relayer service submits and pays for every action.

```ts
// UI
const outcome = await wallet.send("@maria", "5.00");
// inside: build contract call → passkey prompt → relayer.submit
```

No trustline, no sponsorship sandwich, no device key to store.

### Screening

| Red flag               | A. Server ledger                                                                                      | B. Device outbox                                                                                                | C. Contract account                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Shallow module         | First draft had `prepare`, `submit`, `status`. Revised to one replayable call                         | Server exposes `cosign(envelope)`, a single internal stage. The phone coordinates five steps across the network | Three vendor services, each called in order by the phone |
| Information leakage    | Transaction layout is known to the builder and to the phone's checker. Revised: both live in one file | Layout and fee policy live in the phone's builder and again in the server's validator, in two deploy units      | Contract interface leaks into every caller               |
| Temporal decomposition | First draft split build, sign, submit, poll. Revised to modules by knowledge owned                    | Outbox, submitter and poller are steps, not owners                                                              | Not assessed                                             |
| Pass-through method    | App adapters only move data, but they also bind transport and layers. Accepted                        | `directory.resolve` forwards to a table                                                                         | Not assessed                                             |
| Split ownership        | Each table has one writer                                                                             | Transfer state lives in the phone's outbox and on chain. Any later server-driven flow adds a second writer      | State split between contract, relayer and app            |
| Two ways               | One path for every signed action                                                                      | Payment links and refunds must run on the server, so a second submission path appears                           | Classic accounts are still needed for exchange memos     |
| Importable internals   | Package `exports` hide everything but two entries                                                     | Same mechanism available                                                                                        | Same                                                     |
| Hand-synced list       | The method list is defined once and derived elsewhere                                                 | Sponsor's allowed layouts must mirror the phone's builder by hand                                               | Not assessed                                             |

Outcome:

- **A** survives after two revisions, both applied below.
- **B** is rejected. It cannot finish a payment once the phone is gone, its safety depends on storage the app does not control, and old cached app versions would keep building transactions to old rules.
- **C** is rejected on facts from the official docs. A contract call cannot carry a memo, exchanges do not reliably credit contract transfers, and it needs a relayer service the repo does not have.

Parts of B and C are grafted into A. See `rationale.md`.

## 2. Module map

One new package. Nothing else is added.

```text
packages/wallet/                    @workspace/wallet
  package.json                      exports "." and "./server" and nothing else
  src/
    index.ts                        CONTRACT   shared types and device client exports
    contract/                       internal   schema files behind index.ts
    stellar/                        internal   the only code that knows Stellar's format
      network.ts                               passphrase, USDC asset, time-bound policy
      envelopes.ts                             draft a transaction; read one back
    server/
      index.server.ts               SERVER     exports Wallet, WalletSettings
      Wallet.ts                                orchestrates the three below
      Directory.ts                  internal   usernames and addresses. Only writer of `wallets`
      Transfers.ts                  internal   exactly-once record. Only writer of `transfers`
      Chain.ts                      internal   RPC calls, sponsor signatures, settlement
      tables.ts                     internal   Drizzle tables
    device/
      index.ts                      DEVICE     re-exported by the root entry
      client.ts                     internal   the approve-and-replay loop
      Keyring.ts                    internal   the key, and the only code that signs

apps/web/src/
  server/wallet.ts                  builds the per-request layer, like server/db.ts
  server.ts                         Worker entry: fetch + scheduled sweep
  wallet/port.functions.ts          three server functions and their client half
  wallet/index.ts                   export const wallet = connectWallet(port)
```

What each module knows that no other module does:

| Module      | Its secret                                                                          |
| ----------- | ----------------------------------------------------------------------------------- |
| `stellar/`  | Operation layouts, the sponsorship sandwich, fee bumps, XDR, the network passphrase |
| `Chain`     | The RPC API, reserve sponsor and fee payer keys, and settlement evidence            |
| `Transfers` | The state machine, the one-in-flight rule, the SQL that makes transitions atomic    |
| `Directory` | Username rules, claim expiry, the mapping table                                     |
| `Keyring`   | Where the key lives, how it is created, what must be true before it signs           |
| `client`    | The replay loop and the polling schedule                                            |
| App files   | TanStack server functions, Cloudflare bindings                                      |

The modules are split by what they know, not by when they run. Drafting, sealing and submitting all sit in `Chain` because they share one secret.

## 3. Usage

The UI imports one value.

```tsx
// apps/web/src/routes/index.tsx — home screen
import { createFileRoute } from "@tanstack/react-router";
import * as Match from "effect/Match";
import { formatUsdc } from "@workspace/wallet";
import { wallet } from "@/wallet";

export const Route = createFileRoute("/")({
  ssr: false, // the key lives in the browser, so this loader cannot run on the server
  loader: () => wallet.overview(),
  component: Home,
});

function Home() {
  const overview = Route.useLoaderData();

  return Match.valueTags(overview, {
    NoWallet: () => <Welcome />,
    Offline: () => <OfflineNotice />,
    Holding: ({ profile, balance, latest }) => (
      <Balance username={profile.username} amount={formatUsdc(balance)} latest={latest} />
    ),
  });
}
```

```tsx
// apps/web/src/routes/send.tsx — the send button
const router = useRouter();

async function onConfirm(recipientText: string, amountText: string) {
  const outcome = await wallet.send(recipientText, amountText);

  Match.valueTags(outcome, {
    Settled: (receipt) => showSent(receipt),
    Pending: (receipt) => showOnItsWay(receipt), // durable: the server will finish it
    Failed: (receipt) => showNotSent(receipt), // proven: it can never arrive
    SenderBusy: ({ inFlight }) => showOnItsWay(inFlight),
    InsufficientBalance: ({ available }) => showTooMuch(available),
    UnknownRecipient: () => showNoSuchUser(),
    InvalidRecipient: () => showBadUsername(),
    InvalidAmount: () => showBadAmount(),
    NoWallet: () => router.navigate({ to: "/welcome" }),
    DraftRejected: () => showSecurityStop(),
    Offline: () => showTryAgain(), // nothing was signed, or the answer is on the home screen
  });

  await router.invalidate();
}
```

```tsx
// apps/web/src/routes/welcome.tsx — create a wallet
async function onSubmit(usernameText: string) {
  const outcome = await wallet.create(usernameText);

  Match.valueTags(outcome, {
    Opened: () => router.navigate({ to: "/" }),
    UsernameTaken: () => showTaken(),
    InvalidUsername: () => showRules(),
    UnsupportedDevice: () => showUpdateBrowser(),
    DraftRejected: () => showSecurityStop(),
    Offline: () => showTryAgain(), // safe to press again: opening converges
  });
}
```

Three things the caller never does: it never retries, never polls, and never sees a transaction. Every outcome is a value, so adding one breaks the build at each call site until it is handled.

## 4. The contract

`@workspace/wallet`. It imports only `effect/Schema`, so it is safe in the first-load bundle.

```ts
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
export const Usdc = Schema.BigIntFromString.check(/* 0 ≤ units ≤ int64 max */).pipe(
  Schema.brand("Usdc"),
);
export type Usdc = typeof Usdc.Type;

export const PositiveUsdc = Usdc.check(/* units > 0 */).pipe(Schema.brand("PositiveUsdc"));
export type PositiveUsdc = typeof PositiveUsdc.Type;

/** "5", "5.5", "5.50" → base units. None when it is not a positive amount with ≤ 7 decimals. */
export declare function parseUsdc(text: string): Option.Option<PositiveUsdc>;
export declare function formatUsdc(amount: Usdc): string;

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
]);
export type OpenStep = typeof OpenStep.Type;

// --- transfers ----------------------------------------------------------

/** Minted on the phone with crypto.randomUUID() before any network call. */
export const TransferId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("TransferId"));
export type TransferId = typeof TransferId.Type;

// Recipient variants carry a username, phone or address; phone support is deferred.
export const Recipient = Schema.Union([
  Schema.TaggedStruct("Username", { value: Username }),
  Schema.TaggedStruct("Phone", { value: Schema.String }),
  Schema.TaggedStruct("Address", { value: AccountAddress }),
]);

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

export const Overview = Schema.Union([NotOpened, Holding]);
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

export type DeviceOverview = Holding | NoWallet | Offline;
export type CreateOutcome =
  | Opened
  | UsernameTaken
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

class ExpectOpening extends Schema.TaggedClass<ExpectOpening>()("ExpectOpening", {
  address: AccountAddress,
}) {}
class ExpectPayment extends Schema.TaggedClass<ExpectPayment>()("ExpectPayment", {
  from: AccountAddress,
  to: AccountAddress,
  amount: PositiveUsdc,
}) {}
type Expectation = ExpectOpening | ExpectPayment;

class KeyringUnavailable extends Schema.TaggedError<KeyringUnavailable>()("KeyringUnavailable", {
  cause: Schema.Defect(),
}) {}

class Keyring extends Context.Service<
  Keyring,
  {
    /** None until a key exists on this device. */
    readonly address: Effect.Effect<Option.Option<AccountAddress>, KeyringUnavailable>;
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

## 6. The server entry

`@workspace/wallet/server`.

```ts
export class WalletSettings extends Context.Service<
  WalletSettings,
  {
    readonly rpcUrl: string;
    readonly reserveSponsorSecret: Redacted.Redacted<string>;
    readonly feePayerSecret: Redacted.Redacted<string>;
  }
>()("@workspace/wallet/server/WalletSettings") {}

export class Wallet extends Context.Service<
  Wallet,
  WalletPort & {
    /** Drives every in-flight transfer to its end. Called by the scheduled trigger. */
    readonly sweep: Effect.Effect<void, WalletUnavailable>;
  }
>()("@workspace/wallet/server/Wallet") {
  static readonly layer: Layer.Layer<Wallet, never, WalletSettings | PgClient.PgClient> =
    Layer.effect(Wallet, Effect.die("not implemented")).pipe(
      Layer.provide([Directory.layer, Transfers.layer, Chain.layer]),
    );
}
```

This step exposes the three port operations, scheduled sweep and settings. The two passkey operations are deferred to the backup step.

### Internal services

```ts
// server/Chain.ts — all I/O with Stellar, and the sponsor key

/** A transaction the server has fully signed and may submit. */
class Sealed extends Schema.Class<Sealed>("@workspace/wallet/server/Sealed")({
  envelope: Schema.String.pipe(Schema.brand("SealedEnvelope")),
  hash: Schema.String.pipe(Schema.brand("TransactionHash")),
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

class Applied extends Schema.TaggedClass<Applied>()("Applied", {
  at: Schema.DateTimeUtcFromString,
}) {}
/** Included in a ledger, an operation failed, nothing moved. */
class Rejected extends Schema.TaggedClass<Rejected>()("Rejected", { code: Schema.String }) {}
/** Never included, and the ledger clock is past its time bound. */
class Expired extends Schema.TaggedClass<Expired>()("Expired", {}) {}
class Undecided extends Schema.TaggedClass<Undecided>()("Undecided", {}) {}
type Settlement = Applied | Rejected | Expired | Undecided;

class ChainUnreachable extends Schema.TaggedError<ChainUnreachable>()("ChainUnreachable", {
  cause: Schema.Defect(),
}) {}
class ApprovalInvalid extends Schema.TaggedError<ApprovalInvalid>()("ApprovalInvalid", {}) {}

class Chain extends Context.Service<
  Chain,
  {
    /** None when the account or its USDC trustline does not exist. */
    balance(address: AccountAddress): Effect.Effect<Option.Option<Usdc>, ChainUnreachable>;
    draftOpening(address: AccountAddress): Effect.Effect<SigningRequest, ChainUnreachable>;
    draftPayment(
      from: AccountAddress,
      to: AccountAddress,
      amount: PositiveUsdc,
    ): Effect.Effect<SigningRequest, ChainUnreachable>;
    /** Checks the holder's signature, then adds the sponsor's. No network. */
    seal(
      request: SigningRequest,
      approval: Approval,
      holder: AccountAddress,
    ): Effect.Effect<Sealed, ApprovalInvalid>;
    /** Safe to repeat. Returns nothing on purpose. */
    submit(sealed: Sealed): Effect.Effect<void, ChainUnreachable>;
    /** The only source of a final answer. */
    settlement(sealed: Sealed): Effect.Effect<Settlement, ChainUnreachable>;
  }
>()("@workspace/wallet/server/Chain") {
  static readonly layer: Layer.Layer<Chain, never, WalletSettings> = Layer.effect(
    Chain,
    Effect.die("not implemented"),
  );
}
```

`submit` returns `void`. Nothing in the program can read a submit response and conclude that a payment failed, because there is no value to read.

```ts
// server/Transfers.ts — the exactly-once record

class Proposed extends Schema.TaggedClass<Proposed>()("Proposed", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  request: SigningRequest,
}) {}
class Authorized extends Schema.TaggedClass<Authorized>()("Authorized", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  sealed: Sealed,
}) {}
class Concluded extends Schema.TaggedClass<Concluded>()("Concluded", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  receipt: Schema.Union([Settled, Failed]),
}) {}
type Transfer = Proposed | Authorized | Concluded;

class SlotTaken extends Schema.TaggedClass<SlotTaken>()("SlotTaken", { holder: Authorized }) {}
class StoreFailure extends Schema.TaggedError<StoreFailure>()("StoreFailure", {
  cause: Schema.Defect(),
}) {}

class Transfers extends Context.Service<
  Transfers,
  {
    find(id: TransferId): Effect.Effect<Option.Option<Transfer>, StoreFailure>;
    latestFrom(sender: AccountAddress): Effect.Effect<Option.Option<Transfer>, StoreFailure>;
    /** Insert, or return what the id already holds. Replaces an expired unsigned draft. */
    propose(
      order: TransferOrder,
      recipient: ResolvedRecipient,
      request: SigningRequest,
    ): Effect.Effect<Transfer, StoreFailure>;
    /** Proposed → Authorized, once. Fails over to the current state if it lost the race. */
    authorize(
      id: TransferId,
      sealed: Sealed,
    ): Effect.Effect<Authorized | Concluded | SlotTaken, StoreFailure>;
    /** Authorized → Concluded, once. */
    conclude(
      id: TransferId,
      settlement: Applied | Rejected | Expired,
    ): Effect.Effect<Concluded, StoreFailure>;
    readonly inFlight: Effect.Effect<ReadonlyArray<Authorized>, StoreFailure>;
  }
>()("@workspace/wallet/server/Transfers") {
  static readonly layer: Layer.Layer<Transfers, never, PgClient.PgClient> = Layer.effect(
    Transfers,
    Effect.die("not implemented"),
  );
}
```

The state union carries the invariants. A `Sealed` envelope exists only on `Authorized`. `conclude` does not accept `Undecided`. A hash cannot be read from a transfer that was never signed.

```ts
// server/Directory.ts — who is who

class Claimed extends Schema.TaggedClass<Claimed>()("Claimed", {
  claim: WalletClaim,
  attempt: Schema.OptionFromNullOr(Schema.Union([SigningRequest, Sealed])),
}) {}
class Active extends Schema.TaggedClass<Active>()("Active", { profile: Profile }) {}
class Taken extends Schema.TaggedClass<Taken>()("Taken", {}) {}

class Directory extends Context.Service<
  Directory,
  {
    byAddress(address: AccountAddress): Effect.Effect<Option.Option<Profile>, StoreFailure>;
    byUsername(username: Username): Effect.Effect<Option.Option<Profile>, StoreFailure>;
    /** Reserve the pair, or return what already holds it. A stale claim can be taken over. */
    claim(claim: WalletClaim): Effect.Effect<Claimed | Active | Taken, StoreFailure>;
    /** Remember the current opening attempt for this claim. */
    attempt(
      address: AccountAddress,
      attempt: SigningRequest | Sealed,
    ): Effect.Effect<void, StoreFailure>;
    activate(address: AccountAddress): Effect.Effect<Profile, StoreFailure>;
  }
>()("@workspace/wallet/server/Directory") {
  static readonly layer: Layer.Layer<Directory, never, PgClient.PgClient> = Layer.effect(
    Directory,
    Effect.die("not implemented"),
  );
}
```

### Tables

```ts
// server/tables.ts — imported only by Directory.ts and Transfers.ts

export const wallets = pgTable("wallets", {
  address: text().primaryKey(),
  username: text().notNull().unique(),
  status: text({ enum: ["claimed", "opening", "active", "recovered"] }).notNull(),
  claimedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  attemptEnvelope: text(), // the opening draft, then the sealed opening
  attemptHash: text(), // set once sealed
  attemptExpiresAt: timestamp({ withTimezone: true }),
});

export const transfers = pgTable(
  "transfers",
  {
    id: uuid().primaryKey(), // the phone's TransferId; there is no second identifier
    sender: text()
      .notNull()
      .references(() => wallets.address),
    recipient: text(), // nullable; phone and external addresses need not be wallet rows
    amount: bigint({ mode: "bigint" }).notNull(),
    status: text({ enum: ["proposed", "authorized", "settled", "failed"] }).notNull(),
    envelope: text().notNull(), // unsigned while proposed; sealed and frozen from authorized on
    hash: text(), // set with the sealed envelope
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    failure: text({ enum: ["expired", "rejected"] }),
    concludedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // At most one signed, unfinished transfer per sender. This is the sequence-number lock.
    uniqueIndex("transfers_one_in_flight")
      .on(table.sender)
      .where(sql`${table.status} = 'authorized'`),
  ],
);
```

Record network, testnet epoch and contract ID on relevant rows; the testnet reset is 2026-12-16. Defer `phone_identities`, `otp_challenges` and `pending_transfers`.

Each transition is one conditional statement that returns the row, for example `UPDATE transfers SET status = 'authorized', envelope = …, hash = … WHERE id = … AND status = 'proposed' AND expires_at > now() RETURNING *`. No decision is made from a plain `SELECT`, because Hyperdrive may serve one from cache.

### Stellar code

```ts
// stellar/envelopes.ts — a builder and its inverse, side by side

class OpeningFacts extends Schema.TaggedClass<OpeningFacts>()("OpeningFacts", {
  address: AccountAddress,
}) {}
class RecoveryFacts extends Schema.TaggedClass<RecoveryFacts>()("RecoveryFacts", {
  address: AccountAddress,
  reserveSponsor: AccountAddress,
  // Include sequence, minTime and maxTime in the concrete schema.
}) {}
class PaymentFacts extends Schema.TaggedClass<PaymentFacts>()("PaymentFacts", {
  from: AccountAddress,
  to: AccountAddress,
  amount: PositiveUsdc,
}) {}

/** Sponsor is the source. Sandwich: begin sponsoring, create account with 0, trust USDC, end. */
export declare function draftOpening(
  /* sponsor account, new address, time bound */
): UnsignedEnvelope;
/** Holder is the source. Exactly one USDC payment, no memo, a time bound. */
export declare function draftPayment(/* holder account, facts, time bound */): UnsignedEnvelope;

/** Recovery: user source, next sequence, minTime and maxTime, USDC limit 0, merge to reserve sponsor. */
export declare function draftRecovery(
  /* user, reserve sponsor, sequence, time bounds */
): UnsignedEnvelope;

/** None unless the envelope is exactly an allowed layout, with nothing extra. */
export declare function readEnvelope(
  envelope: UnsignedEnvelope,
): Option.Option<OpeningFacts | PaymentFacts | RecoveryFacts>;

/** The 32 bytes a signature covers. */
export declare function signingPayload(envelope: UnsignedEnvelope): Uint8Array;
```

`Chain` calls the `draft…` functions. `Keyring` calls `readEnvelope`. A test asserts `readEnvelope(draftPayment(x))` equals `x` for generated `x`, so a change to one side that forgets the other fails.

## 7. The app's part

```ts
// apps/web/src/server/wallet.ts — composition root, same form as server/db.ts
import { env } from "cloudflare:workers";

const requestWalletLayer = Layer.suspend(() =>
  Wallet.layer.pipe(
    Layer.provide(
      Layer.succeed(WalletSettings, {
        rpcUrl: env.STELLAR_RPC_URL,
        reserveSponsorSecret: Redacted.make(env.RESERVE_SPONSOR_SECRET),
        feePayerSecret: Redacted.make(env.FEE_PAYER_SECRET),
      }),
    ),
    Layer.provide(databaseLayer(env.HYPERDRIVE)),
  ),
);

/** Runs one wallet program in the current request. */
export declare function runWallet<A>(
  program: Effect.Effect<A, WalletUnavailable, Wallet>,
): Promise<A>;
```

```ts
// apps/web/src/wallet/port.functions.ts — both halves of each call in one file

const TransferCall = Schema.Struct({
  order: TransferOrder,
  approval: Schema.OptionFromNullOr(Approval),
});

const transferFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(TransferCall))
  .handler(({ data }) =>
    runWallet(
      Wallet.use((wallet) => wallet.transfer(data.order, data.approval)).pipe(
        Effect.flatMap(Schema.encodeEffect(TransferStep)),
        // an encode failure is a defect, not a WalletUnavailable
      ),
    ),
  );

/** Client half: encode, call, decode. Any rejection becomes WalletUnavailable. */
export const port: WalletPort = {
  overview: (address) => Effect.die("not implemented"),
  open: (claim, approval) => Effect.die("not implemented"),
  transfer: (order, approval) => Effect.die("not implemented"),
  // Add protect and recover transports when their schemas are defined; see backup.md.
};
```

```ts
// apps/web/src/wallet/index.ts — the only wallet import the UI needs
export const wallet = connectWallet(port);
```

```ts
// apps/web/src/server.ts — Worker entry; wrangler.jsonc "main" points here
export default {
  fetch: handler.fetch,
  scheduled: () => runWallet(Wallet.use((wallet) => wallet.sweep)),
};
```

The app holds no wallet rules. It binds a transport and the reserve sponsor and fee payer secrets. A separate attester key is a future third role; see `rationale.md`.

## 8. Flows

### Transfer, server side

```text
transfer(order, approval):
  existing = Transfers.find(order.id)

  existing is Concluded            → its receipt
  existing is Authorized           → reconcile(existing)                       ← this is also "status"
  existing is Proposed, live:
      approval is none             → TransferDraft(existing.request)           ← replay of the first call
      approval is some             → sealed = Chain.seal(request, approval, order.from)
                                       ApprovalInvalid → TransferDraft(existing.request)
                                     Transfers.authorize(id, sealed)
                                       SlotTaken → reconcile(holder); still pending → SenderBusy
                                     Chain.submit(sealed)                      ← errors ignored
                                     → Pending
  existing is none, or Proposed and expired:
      sender    = Directory.byAddress(order.from)        none → NotOpened
      recipient = Directory.byUsername(order.to)         none → UnknownRecipient
      held      = Transfers.latestFrom(order.from)       Authorized → reconcile; still pending → SenderBusy
      available = Chain.balance(order.from)              < amount → InsufficientBalance
      request   = Chain.draftPayment(from, recipient.address, amount)
      Transfers.propose(order, recipient, request)
      → TransferDraft(request, recipient)

reconcile(authorized):
  Chain.settlement(sealed):
    Applied | Rejected | Expired   → Transfers.conclude(id, it) → Settled or Failed
    Undecided                      → Chain.submit(sealed) again → Pending
```

`overview` reconciles the sender's latest transfer the same way before answering. `sweep` reconciles every in-flight transfer.

### What each failure does

| What goes wrong                            | What happens                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Network drops before the first call lands  | Nothing exists. The client retries the same order                                                       |
| The draft response is lost                 | The retry returns the same draft. Still one envelope                                                    |
| App closes before signing                  | An unsigned draft expires. No later code can sign it. Shown as never sent                               |
| The approval request is lost               | Same as above                                                                                           |
| The approval lands, the response is lost   | The transfer is authorized. The retry returns `Pending`                                                 |
| App closes right after approving           | The server holds the sealed envelope. Submit already ran; the sweep repeats it. Home shows it on reopen |
| The submit call fails                      | Ignored. Reconcile submits again while the envelope can still be included                               |
| The transaction is submitted twice         | Same bytes, same sequence number. The network applies it once                                           |
| User taps send twice                       | Two orders. The second gets `SenderBusy` while the first is in flight                                   |
| Database write fails at authorize          | Nothing was submitted. The client retries with the same approval                                        |
| Worker dies between authorize and submit   | Authorized but unsent. Reconcile or sweep submits it, or it expires and fails                           |
| RPC is down for longer than the time bound | Reconcile reports `Undecided` until RPC answers, then reads the ledger clock and decides                |
| A transfer fails and the user sends again  | A new order. Safe, because `Failed` is only ever written with proof                                     |

### Opening, server side

```text
open(claim, approval):
  Directory.claim(claim):
    Taken                          → UsernameTaken
    Active(profile)                → Opened(profile)
    Claimed(attempt):
      Chain.balance(address) is some → keep status opening; load confirmed sequence
                                     → draft recovery if absent; return RecoveryDraft
                                     → verify approval against stored recovery draft
                                     → store signed recovery unsubmitted; activate → Opened
      attempt is Sealed            → Chain.settlement:
                                       Undecided → submit again → OpeningPending
                                       Rejected | Expired → draft again (below)
      attempt is a live draft and approval is some
                                   → Chain.seal → Directory.attempt(sealed) → Chain.submit → OpeningPending
      otherwise                    → request = Chain.draftOpening(address); Directory.attempt(request)
                                     → OpeningDraft(request)
```

Opening is not exactly-once and does not need to be. Its goal is a state: the account exists, trusts USDC and has a valid signed recovery transaction stored. Creating an account twice is impossible on the ledger, so any number of attempts is safe, and the client simply replays until it reads `Opened`.

The sponsor is the source of every opening transaction, so openings share its sequence number. Two people who sign up in the same few seconds get drafts with the same number; one is applied and the other is drafted again on its next replay. The network also takes only one transaction per source account per ledger. Sign-ups are therefore limited to about one per ledger close. A pool of channel accounts lifts that limit and fits inside `Chain` without changing any signature here.

### Policy constants

They live in `stellar/network.ts` and nowhere else: the testnet passphrase, the USDC code and issuer, and the time bound. A payment draft is valid for 120 seconds. An approval is accepted only while at least 20 seconds remain; otherwise the server drafts again.

## 9. How the boundaries hold

| Rule                                              | What enforces it                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Nothing outside the package imports its internals | The planned `exports` lists two entries. Any other path fails to resolve in `tsc` and in Vite      |
| Tables are written by one module each             | `tables.ts` is not exported, so no other package can reach it. Inside the package it is convention |
| No signature without a check                      | `Keyring` is not exported and has no raw sign method                                               |
| The server signs only what it drafted             | `seal` takes a stored `SigningRequest`; `Approval` has no envelope field                           |
| A final state needs ledger proof                  | `conclude` does not accept `Undecided`; `submit` returns `void`                                    |
| The port's three sides agree                      | One `WalletPort` interface. `Wallet`, `port` and `connectWallet` are all typed by it               |
| Every outcome is handled                          | Outcomes are tagged unions; `Match.valueTags` is exhaustive                                        |
| Server code stays out of the browser              | Not yet enforced. See the open questions                                                           |

## 10. API names and where they were checked

Checked in installed source: `Context.Service`, `Layer.effect`, `Layer.succeed`, `Layer.suspend`, `Layer.provide`, `Effect.fn`, `Effect.die`, `Effect.flatMap`, `Schema.Class`, `Schema.TaggedClass`, `Schema.TaggedError`, `Schema.Union`, `Schema.Literals`, `Schema.Struct`, `Schema.brand`, `Schema.isPattern`, `Schema.isUUID`, `Schema.BigIntFromString`, `Schema.Uint8ArrayFromBase64`, `Schema.DateTimeUtcFromString`, `Schema.OptionFromNullOr`, `Schema.Defect`, `Schema.toStandardSchemaV1`, `Schema.encodeEffect`, `Match.valueTags`, `Redacted.make`, `createServerFn().validator().handler()`, `ssr: false`, `pgTable`, `uniqueIndex().on().where()`, `text({ enum })`, `bigint({ mode })`, `timestamp({ withTimezone })`, `uuid()`.

Not checked: `.check(...)` applied to a schema that is already a transformation (`BigIntFromString`), the exact form of a bigint range filter, and `Layer.provide` taking an array. These are details of bodies, not of the design.
