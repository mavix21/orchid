# Wallet on testnet: grounding

This file explains the systems the wallet touches. It records how each one behaves and why that matters for the design. A claim marked _(unverified)_ was not confirmed against source or official docs. Those claims also appear in the open questions in `rationale.md`.

How each claim was verified: repo files were read directly. The worktree has no `node_modules`, so library claims were checked against the exact locked versions in the Bun cache (`~/.bun/install/cache`). Stellar SDK claims were checked against the type declarations in the published `@stellar/stellar-sdk@17.4.0` tarball, which was extracted to a scratch directory and not installed. Protocol claims come from developers.stellar.org.

## 1. The web app and its server

`apps/web` is a TanStack Start app (`@tanstack/react-start@1.169.5`, locked in `bun.lock`) built by Vite 8. `@cloudflare/vite-plugin` runs Start's `ssr` Vite environment inside workerd. `wrangler.jsonc` sets `main: "@tanstack/react-start/server-entry"`. So the Worker _is_ the Start server: SSR, server functions and server routes all run in one Worker script per request. Today there is one route (`/`), with no server functions and no server routes.

Server functions are the official way for the client to reach the server. In the locked `@tanstack/start-client-core@1.170.39`, the builder is `createServerFn({ method }).validator(v).handler(fn)`. The method is `.validator`, not `.inputValidator`. A validator may be a Standard Schema (`router-core` `StandardSchemaValidator`). The input must be serializable by seroval, and so must the returned value. The compiler swaps the handler for an RPC stub in the client build. One thing is not settled: whether the `.validator(...)` argument, and the imports it needs, are stripped from the client build _(unverified)_.

Two Start features matter for the boundary:

- **Selective SSR.** A route accepts `ssr: boolean | "data-only"` (`router-core` `SSROption`). Wallet routes can set `ssr: false`, so their loaders run only in the browser, which is the only place the signing key exists.
- **Import protection.** `start-plugin-core` has an import-protection plugin. By default, the client environment denies files matching `**/*.server.*` and the specifier `@tanstack/react-start/server`, outside `**/node_modules/**`. Its effective behavior is `behavior.build ?? "error"` for builds and `behavior.dev ?? "mock"` in dev. So by default, a `*.server.ts` file pulled into client code **fails `bun run build`**. The default rules exclude `node_modules`. Whether Vite resolves a Bun workspace symlink to its real path (`packages/...`) in this setup, so that the rule applies, is _(unverified)_.

The Worker reads bindings through `import { env } from "cloudflare:workers"`, as `apps/web/src/server/db.ts` does. Secrets (a sponsor secret key) and vars (an RPC URL) would come from the same `env` and be declared in `wrangler.jsonc` / `wrangler secret`. `nodejs_compat` is enabled.

## 2. packages/db and the Effect layering

`@workspace/db` exports two things:

- `databaseLayer(hyperdrive)`, which is `PgClient.layer({ url: Redacted.make(connectionString) })` from `@effect/sql-pg@4.1.4`. It is a `Layer<PgClient | SqlClient, SqlError>`. The language service treats it as an unstable API, so `packages/db/tsconfig.json` allows it via `allowedUnstableApis`.
- `makeDatabase`, which is `drizzle-orm/effect-postgres` `makeWithDefaults`. It returns `Effect<EffectPgDatabase & { $client }, never, PgClient>`, with Drizzle's no-op logger and cache already provided.

`apps/web/src/server/db.ts` builds `requestDatabaseLayer = Layer.suspend(() => databaseLayer(env.HYPERDRIVE))`. `Layer.suspend` makes the layer read `env` and open its pool when it is built inside a request, not at module load. That matters on Workers, where I/O objects cannot outlive the request that created them. Hyperdrive is the pooling layer between Workers and Postgres. Locally, `localConnectionString` connects straight to Docker Postgres.

Drizzle `1.0.0-rc.5` effect-postgres gives `db.transaction(tx => Effect)`, which returns `Effect<A, E | SqlError, R>`. Insert supports `.onConflictDoNothing({ target })` and `.returning()`. Columns include `bigint(name, { mode: "bigint" })` and `pgEnum`. The schema (`packages/db/src/schema.ts`) is empty, and the README says application tables go there. No migration tool (drizzle-kit) is installed.

### Effect 4.1.4 conventions in use

- Services: `class X extends Context.Service<X, { ... }>()("key") {}`. The key is the runtime identity. A service key is itself an `Effect` that yields the service, and `X.use(f)` runs `f` against the service.
- Layers: `Layer.effect(X, effect)`, `Layer.succeed`, `Layer.provide`, `Layer.suspend`, and `ManagedRuntime.make(layer)` with `runPromise` / `runPromiseExit` for the browser.
- Errors: `class E extends Schema.TaggedError<E>()("E", { fields }) {}`. These are schema-backed, so they can be encoded over the wire. They are handled with `Effect.catchTag` / `catchTags`.
- Parsing: `Schema.brand`, `Schema.TaggedStruct`, `Schema.TaggedClass`, `Schema.Union`, `Schema.BigIntFromString`, `Schema.DateTimeUtcFromString`, and `Schema.toStandardSchemaV1(schema)`. The last one returns `StandardSchemaV1<Encoded, Type>`, so an Effect Schema can be a Start validator directly.
- `effect/rpc` exists, but its server and client entry points are marked `@stability unstable`.

### Lint rules that shape the code (oxlint, all errors)

- `no-object-parameters`, `no-unknown-parameters`/`returns`/`type-aliases`, `no-runtime-typeof`: values are decoded at the boundary and typed after that.
- `no-shape-in-symbol-names`: no identifier may contain "shape".
- `require-safety-comment-for-type-assertion` and `no-widen-then-assert`: no casts.
- Effect rules: `catchTag` instead of `_tag` branching, `Match.tags` instead of manual tag comparisons, constructors instead of `{ _tag }` literals, and no imports of project-local `make*` service constructors outside tests. Code depends on the Layer and yields the service instead.

## 3. Workers runtime constraints

- **Request-scoped I/O.** Postgres connections, `fetch` and timers belong to the request. Work after the response needs `ctx.waitUntil`. This design does not need it: submission is driven to a result inside the request, and is then reconciled the next time someone reads it.
- **CPU time and subrequest caps depend on the plan** _(exact numbers for this account unverified)_. Waiting on `fetch` does not count as CPU time. Each poll of `getTransaction` is a subrequest, so polling has to be bounded.
- **No shared memory between requests.** Any state that must survive retries (usernames, submitted transfers) lives in Postgres, not in module globals.
- **Library fit.** `@stellar/stellar-sdk@17.4.0` uses fetch by default (it depends on `feaxios`, with an axios build behind `./axios`). It signs with `@noble/ed25519` and `@noble/hashes`, which are pure JS. Whether its `rpc` entry bundles cleanly for workerd under `nodejs_compat` is _(unverified)_.

## 4. Stellar, as far as this wallet needs it

**Accounts and minimum balance.** An account (G-address) exists only once it is created on-ledger. It must hold `(2 + subentries + sponsoring − sponsored) × base reserve`. The base reserve is currently 0.5 XLM. Each trustline is one subentry. Spendable XLM is `balance − minimum balance − selling liabilities`.

**Trustlines.** An account must hold a trustline to an asset (`ChangeTrust`, source = that account) before it can receive that asset. A trustline balance is an int64 with 7 implied decimals. USDC on testnet is code `USDC`, issued by Circle at `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`. That issuer address is not the asset's Soroban (SAC) contract address.

**Sponsored reserves.** A sponsor pays another account's reserves with a sandwich inside one transaction: `BeginSponsoringFutureReserves(sponsored)` (sponsor signs), the sponsored operations, then `EndSponsoringFutureReserves` (source = sponsored account, which signs). Begin and end must both be in the same transaction. Wrapping `CreateAccount` this way allows a **starting balance of 0**. Wrapping `ChangeTrust` lets the sponsor pay for the trustline's reserve. So one transaction signed by the sponsor _and_ the new key can create a zero-XLM account that already trusts USDC. The new account cannot be the transaction source, because it does not exist yet. So the source is the sponsor, and the transaction uses up a sponsor sequence number.

**Fees and fee bumps.** A fee is a bid per operation, and it must be at least the network minimum. A fee-bump transaction wraps an already-signed inner transaction, and a different account pays for it. Its fee must cover (inner ops + 1) × the minimum and must be at least the inner fee. The inner result is the same as without the bump, except that the inner fee is charged as 0. The **sequence number still comes from the inner source account**, and the bump does not change the inner signature. A second bump of the same inner transaction replaces a queued one only if its fee bid is at least 10×. This means a user with 0 XLM can send USDC: the user signs the inner payment and Orchid's account pays the fee.

**Sequence numbers.** A transaction must carry exactly the source account's current sequence + 1, unless sequence preconditions are set. When a transaction is applied, whether it succeeds or fails, the account's sequence is set to the transaction's sequence. So **a signed transaction can apply at most once**, and any two transactions signed with the same sequence are mutually exclusive. RPC `sendTransaction` returns `TRY_AGAIN_LATER` when the account's previous transaction has not settled. In practice, that is one queued transaction per source account at a time.

**Time bounds.** `maxTime` (`TransactionBuilder.setTimeout(seconds)`, which the SDK requires unless explicit time bounds are set) makes a transaction invalid after a deadline. The docs strongly encourage it. If `maxTime` has passed, ledgers have closed after it, and the hash is not on-ledger, the transaction **can never apply**. That is the point at which "not sent" becomes a fact and stops being a guess.

**Memos.** There are four kinds: `MEMO_TEXT` (up to 28 bytes), `MEMO_ID` (uint64), `MEMO_HASH` and `MEMO_RETURN` (32 bytes). One memo per transaction. Exchanges such as Lemon identify deposits by memo, so later withdrawals are a classic `Payment` with a memo. A Soroban SAC `transfer` **cannot** carry a memo; contract accounts can only use a muxed ID (M-address).

**RPC vs Horizon.** The docs describe Horizon as nearing end-of-life: compatibility updates only, no new features. Stellar RPC is the recommended API. `sendTransaction` validates and enqueues, and does not wait. It returns `PENDING | DUPLICATE | TRY_AGAIN_LATER | ERROR`. `getTransaction(hash)` returns `SUCCESS | FAILED | NOT_FOUND`, plus `latestLedger` and `latestLedgerCloseTime`. RPC keeps about 7 days of history by default (120,960 ledgers), so activity history needs its own store. `getLedgerEntries` reads account entries (`seqNum`) and trustline entries (balance). The SDK 17.4.0 `rpc.Server(url)` has `getAccount`, `getTrustline(account, asset)`, `getAssetBalance`, `sendTransaction(tx | feeBump)`, `getTransaction`, `pollTransaction`, `getLatestLedger` and `getHealth`. `@stellar/stellar-base` is deprecated in favor of `@stellar/stellar-sdk`, which exposes the builder API under `@stellar/stellar-sdk/base`: `TransactionBuilder` (including `buildFeeBumpTransaction` and `fromXDR`), `Operation.{createAccount, changeTrust, payment, beginSponsoringFutureReserves, endSponsoringFutureReserves}`, `Keypair.{random, fromSecret}`, `Memo.{text, id}`, and `tx.hash()`.

**Testnet.** The passphrase is `Test SDF Network ; September 2015`, the public RPC is `https://soroban-testnet.stellar.org`, and Friendbot (`https://friendbot.stellar.org`, rate limited) gives XLM only. **Testnet is wiped on resets; one is scheduled for 2026-12-16.** Every testnet account and all testnet history disappear then, while Postgres rows survive.

**Contract (C) accounts.** Payments of SAC tokens between C- and G-addresses work at the protocol level. A C-address needs no classic trustline. Transfers from it cannot carry a text memo, so they cannot reach a memo-identified exchange deposit.

## 5. The browser side

The device keeps the signing key, so it must persist data. IndexedDB is best-effort by default. Under storage pressure the browser evicts _all_ of an origin's data at once, unless `navigator.storage.persist()` was granted. A persistent bucket is cleared only by the origin or by the user. Writes can throw `QuotaExceededError`. On a self-custodial wallet, eviction or "clear site data" destroys the only copy of the key. So persistence has to be requested and a backup story has to exist. Backup is an open question.

## 6. What this forces

1. The key never leaves the device. So the device signs, and every route that needs the key runs with `ssr: false`.
2. The user holds 0 XLM. So Orchid's sponsor account pays both reserves (sponsorship) and fees (fee bump). The server must therefore check whatever it fee-bumps, or it is a free fee faucet.
3. Sequence numbers plus `maxTime` give **at-most-once by construction**. A signed envelope can be resubmitted freely. A _new_ envelope may be signed only after the previous one is final, either on-ledger or expired. No-double-send comes down to "one unresolved envelope per account".
4. RPC history is short-lived and testnet resets. So Orchid keeps its own record of transfers and usernames, and reads balances from the chain instead of storing them.
5. Later features (memo withdrawals, payment links that fund new wallets, pots that refund) are server-originated or memo-bearing classic payments. Classic G-accounts with sponsorship support all of them today.

## Sources

- Sponsored reserves: https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves
- Create account: https://developers.stellar.org/docs/build/guides/transactions/create-account
- Fee-bump transactions: https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions
- Fees: https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering
- Operations and transactions: https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions
- Lumens and reserves: https://developers.stellar.org/docs/learn/fundamentals/lumens
- RPC `sendTransaction`: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/sendTransaction
- RPC `getTransaction`: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction
- RPC `getLedgerEntries`: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getLedgerEntries
- Horizon to RPC migration: https://developers.stellar.org/docs/data/apis/migrate-from-horizon-to-rpc
- Networks: https://developers.stellar.org/docs/networks
- C-account payments: https://developers.stellar.org/docs/build/guides/transactions/send-and-receive-c-accounts
- Circle USDC addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
- Storage quotas and eviction: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
