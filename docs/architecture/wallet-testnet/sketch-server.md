# Sketch: server entry and app wiring

Part of the [core wallet flow sketch](sketch.md). Server services, tables, Stellar code, and what the app adds.

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
  static readonly layer: Layer.Layer<
    Wallet,
    never,
    WalletSettings | PgClient.PgClient
  > = Layer.effect(Wallet, Effect.die("not implemented")).pipe(
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
class Rejected extends Schema.TaggedClass<Rejected>()("Rejected", {
  code: Schema.String,
}) {}
/** Never included, and the ledger clock is past its time bound. */
class Expired extends Schema.TaggedClass<Expired>()("Expired", {}) {}
class Undecided extends Schema.TaggedClass<Undecided>()("Undecided", {}) {}
type Settlement = Applied | Rejected | Expired | Undecided;

class ChainUnreachable extends Schema.TaggedError<ChainUnreachable>()(
  "ChainUnreachable",
  {
    cause: Schema.Defect(),
  },
) {}
class ApprovalInvalid extends Schema.TaggedError<ApprovalInvalid>()(
  "ApprovalInvalid",
  {},
) {}

class Chain extends Context.Service<
  Chain,
  {
    /** None when the account or its USDC trustline does not exist. */
    balance(
      address: AccountAddress,
    ): Effect.Effect<Option.Option<Usdc>, ChainUnreachable>;
    draftOpening(
      address: AccountAddress,
    ): Effect.Effect<SigningRequest, ChainUnreachable>;
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
  static readonly layer: Layer.Layer<Chain, never, WalletSettings> =
    Layer.effect(Chain, Effect.die("not implemented"));
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

class SlotTaken extends Schema.TaggedClass<SlotTaken>()("SlotTaken", {
  holder: Authorized,
}) {}
class StoreFailure extends Schema.TaggedError<StoreFailure>()("StoreFailure", {
  cause: Schema.Defect(),
}) {}

class Transfers extends Context.Service<
  Transfers,
  {
    find(id: TransferId): Effect.Effect<Option.Option<Transfer>, StoreFailure>;
    latestFrom(
      sender: AccountAddress,
    ): Effect.Effect<Option.Option<Transfer>, StoreFailure>;
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
  static readonly layer: Layer.Layer<Transfers, never, PgClient.PgClient> =
    Layer.effect(Transfers, Effect.die("not implemented"));
}
```

The state union carries the invariants. A `Sealed` envelope exists only on `Authorized`. `conclude` does not accept `Undecided`. A hash cannot be read from a transfer that was never signed.

```ts
// server/Directory.ts — who is who

class Available extends Schema.TaggedClass<Available>()("Available", {}) {}
type Unavailable = UsernameTaken | AddressBound;

class Directory extends Context.Service<
  Directory,
  {
    byAddress(
      address: AccountAddress,
    ): Effect.Effect<Option.Option<WalletRow>, StoreFailure>;
    /** Resolves only while the bound wallet is active. */
    byUsername(
      username: Username,
    ): Effect.Effect<Option.Option<Profile>, StoreFailure>;
    /** Soft check before signing; reserves nothing. */
    available(
      claim: WalletClaim,
    ): Effect.Effect<Available | Unavailable, StoreFailure>;
    /** The wallet row for an address, created as `opening`. It carries no name. */
    start(address: AccountAddress): Effect.Effect<WalletRow, StoreFailure>;
    draft(
      row: WalletRow,
      request: SigningRequest,
    ): Effect.Effect<WalletRow, StoreFailure>;
    /** Bind the name and store the signed opening in one transaction, or store nothing. */
    seal(
      row: WalletRow,
      sealed: Sealed,
      claim: WalletClaim,
    ): Effect.Effect<WalletRow | Unavailable, StoreFailure>;
    activate(/* row, signed recovery, claim */): Effect.Effect<
      Option.Option<Profile> | Unavailable,
      StoreFailure
    >;
    recover(row: WalletRow): Effect.Effect<void, StoreFailure>;
  }
>()("@workspace/wallet/server/Directory") {
  static readonly layer: Layer.Layer<Directory, never, PgClient.PgClient> =
    Layer.effect(Directory, Effect.die("not implemented"));
}
```

### Tables

```ts
// server/tables.ts — imported only by Directory.ts and Transfers.ts

export const wallets = pgTable("wallets", {
  address: text().primaryKey(),
  status: text({ enum: ["opening", "active", "recovered"] }).notNull(),
  attemptEnvelope: text(), // the opening draft, then the sealed opening
  attemptHash: text(), // set once sealed
  attemptExpiresAt: timestamp({ withTimezone: true }),
});

// Inserted once when the signed opening is stored; never updated or deleted.
export const usernames = pgTable("usernames", {
  username: text().primaryKey(),
  address: text()
    .notNull()
    .unique()
    .references(() => wallets.address),
  boundAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
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
    status: text({
      enum: ["proposed", "authorized", "settled", "failed"],
    }).notNull(),
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

Each transition is one conditional statement that returns the row, for example `UPDATE transfers SET status = 'authorized', envelope = …, hash = … WHERE id = … AND status = 'proposed' AND expires_at > now() RETURNING *`. Reads are plain `SELECT`s. That is correct only because the wallet's Hyperdrive configuration has query caching disabled, a deployment prerequisite that `apps/web` deploys check (see the package README). The name race is decided by the returned row of `INSERT … ON CONFLICT DO NOTHING RETURNING`, not by a read.

### Stellar code

```ts
// stellar/envelopes.ts — a builder and its inverse, side by side

class OpeningFacts extends Schema.TaggedClass<OpeningFacts>()("OpeningFacts", {
  address: AccountAddress,
}) {}
class RecoveryFacts extends Schema.TaggedClass<RecoveryFacts>()(
  "RecoveryFacts",
  {
    address: AccountAddress,
    reserveSponsor: AccountAddress,
    // Include sequence, minTime and maxTime in the concrete schema.
  },
) {}
class PaymentFacts extends Schema.TaggedClass<PaymentFacts>()("PaymentFacts", {
  from: AccountAddress,
  to: AccountAddress,
  amount: PositiveUsdc,
}) {}

/** Sponsor is the source. Sandwich: begin sponsoring, create account with 0, trust USDC, end. */
export declare function draftOpening(
  /* sponsor account, new address, time bound */
): UnsignedEnvelope;
/** Holder is the source. One USDC payment, optional external text/id memo, a time bound. */
export declare function draftPayment(
  /* holder account, facts, time bound */
): UnsignedEnvelope;

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
