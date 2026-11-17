# Ground: what the wallet flow has to stand on

This is the model the design in `sketch.md` is built from. Each claim is tagged with where it was checked:

- **[repo]** read in this repository.
- **[installed]** read in the installed package source (`node_modules` of the main checkout, same lockfile).
- **[docs]** read on the official documentation site on 2026-11-15.
- **[tarball]** read in the published npm tarball of a package that is not installed yet.
- **[measured]** a local measurement, described where it appears.
- **[unverified]** believed true but not confirmed. Every such item is repeated in the open questions of `rationale.md`.

## 1. The repository today

### What exists

The repo is a scaffold. There are three workspaces and no product code [repo]:

- `apps/web` is a TanStack Start app with one route (`/`) that renders a heading. It deploys as a Cloudflare Worker.
- `packages/db` is a 10-line package that knows how to reach Postgres.
- `packages/ui` holds one shadcn button and the global stylesheet.

There are no tables, no migrations, no server functions, no tests and no test runner.

### How a request reaches the database

`apps/web/wrangler.jsonc` sets the Worker's entry to `@tanstack/react-start/server-entry` and declares one binding, `HYPERDRIVE`. The Cloudflare Vite plugin runs the server bundle inside the Workers runtime, in development too.

`packages/db` exports two things. `databaseLayer(hyperdrive)` returns `PgClient.layer({ url })`, an Effect layer that builds a Postgres connection pool from a connection string. `makeDatabase` is Drizzle's `makeWithDefaults`, an Effect that needs a `PgClient` and returns a typed Drizzle database.

`apps/web/src/server/db.ts` joins the two: `requestDatabaseLayer = Layer.suspend(() => databaseLayer(env.HYPERDRIVE))`, where `env` comes from `cloudflare:workers`. `Layer.suspend` is doing real work here. It delays reading the binding and opening sockets until a program is run, which means until a request exists.

So the intended layering is already visible, even though nothing uses it yet:

1. A program is an Effect that requires services.
2. The app builds the layers per request, from bindings.
3. The app runs the program at the edge with `Effect.runPromise`.

The wallet design keeps this exact pattern and adds no second one.

### Why the layer must be built per request

Cloudflare's Hyperdrive docs say "Create a new client instance for each request" and "Create clients inside your handler — not in global scope" [docs]. Workers also refuse I/O outside a request context [docs]. A module-level `ManagedRuntime` holding a pool, which is the pattern Effect's own integration example shows for Node servers, would be wrong on this platform. Building the layer inside the request, as `db.ts` already does, is the correct form.

### Effect 4 as installed

The installed version is `effect@4.1.4` [installed]. The package ships its own agent guide, and the design follows it:

- Services are classes: `class X extends Context.Service<X, Interface>()("id") {}`, with a static `layer` built by `Layer.effect`. Callers use `X.use((x) => x.method())` or `yield* X`.
- Errors are `Schema.TaggedError<Self>()("Tag", fields)`. Tagged values are `Schema.TaggedClass`.
- Reusable effectful functions use `Effect.fn("Name")(function* () {})`.
- Untrusted input is decoded with `Schema` at the boundary.
- `Schema.toStandardSchemaV1(schema)` turns a schema into a Standard Schema validator.
- `effect/crypto` has a `Signature` service with Ed25519 on WebCrypto. Its source states: "Ed25519 needs Chrome 137, Firefox 129, or Safari 17. There is no fallback for older browsers." Keys can wrap a non-extractable `CryptoKey` (`privateKeyFromCryptoKey`).

### Drizzle as installed

`drizzle-orm@1.0.0-rc.5` with the `effect-postgres` driver [installed]. Queries are Effects that fail with `EffectDrizzleQueryError`. `db.transaction(fn)` exists and adds `SqlError`. There is a `migrate` function, but `drizzle-kit` is not installed, so there is no way to generate migrations yet.

`@effect/sql-pg@4.1.4` speaks the Postgres wire protocol itself over `node:net` and `node:tls`, which is why `nodejs_compat` is on.

### TanStack Start as installed

Version 1.169.5 [installed]. The package bundles its documentation as skill files, which were read:

- `createServerFn({ method }).validator(v).handler(fn)` is the server boundary. The validator accepts a Standard Schema (checked in `createServerFn.ts`: it tests for `"~standard"`).
- Loaders run on both server and client. Server-only work must sit behind `createServerFn`.
- A server function is a public HTTP endpoint. A route guard does not protect it.
- A thrown error crosses the boundary as a rejected promise with a message. Typed errors do not survive it.
- `ssr: false` on a route makes its loader and component run only in the browser.
- Files named `*.server.ts` cannot be imported from client code. The feature is marked experimental.

### Lint rules that constrain the design

The anti-slop rules are errors [repo]. The ones that shape signatures:

- `no-unknown-parameters`, `no-object-parameters`, `no-unsafe-dictionary-type`: every parameter has a named domain type. Raw input is decoded where it enters.
- `no-manual-tagged-construction`, `no-manual-tag-comparison`: tagged values are built with their class constructor and matched with `Match`, never by comparing `_tag`.
- `no-service-constructor-imports`: runtime code may not import a `make…` function from a relative path. Services are reached through their layer.
- `no-module-mocking`: tests replace a dependency by providing a different layer.
- `no-shape-in-symbol-names`: no identifier may contain "shape".

These rules already push toward the design's main habit: decode once at the edge, then pass branded types.

### How a boundary can fail the build in this repo

Workspace packages are consumed through `package.json` `exports`. `@workspace/db` exposes `.` and `./schema` and nothing else. With `moduleResolution: bundler`, an import of any other subpath does not resolve, in TypeScript or in Vite. This is the only build-failing module boundary the repo has. Inside `apps/web` the `@/*` alias makes every file importable from every other file.

## 2. Cloudflare Workers constraints

All from the Workers and Hyperdrive docs [docs].

| Constraint              | Value                             | Why it matters here                                          |
| ----------------------- | --------------------------------- | ------------------------------------------------------------ |
| CPU time per request    | 10 ms Free, 30 s default Paid     | Pure-JavaScript Ed25519 sign and verify may not fit in 10 ms |
| Wall-clock per request  | No hard limit for HTTP            | Waiting on a network call is free; computing is not          |
| Subrequests per request | 50 Free, 10,000 Paid              | One wallet call makes at most four outbound calls            |
| Work after the response | `waitUntil`, 30 s, then cancelled | Not a durability mechanism                                   |
| Global scope            | No I/O; must finish in 1 s        | Clients and pools are built per request                      |
| Cron Triggers           | Down to once a minute             | The only way to run code with no user present                |

Three Hyperdrive facts change how the database may be used:

1. **Pooling is in transaction mode.** A transaction holds one connection, so multi-statement transactions work. Session-level advisory locks are not supported. Transaction-level ones (`pg_advisory_xact_lock`) are.
2. **Query caching is on by default.** Read queries are cached for 60 seconds, and "a later matching `SELECT` can return the cached result". A write does not invalidate the cache. A state machine that reads its own row after writing it can see the old state for a minute.
3. **Local development does not cache** [repo, README]. So a bug caused by fact 2 appears only in production.

The design responds in two ways. Every decision is made by a conditional write that returns the row, never by a read followed by a write. And the wallet's Hyperdrive configuration must have caching disabled, which Cloudflare supports per configuration. A pre-deploy check verifies this (see `packages/wallet/README.md`).

Workers WebCrypto supports Ed25519 for sign, verify, generate, import and export [docs]. Signing with the platform's native implementation costs almost no CPU budget.

A custom Worker entry is documented by Cloudflare for TanStack Start: `src/server.ts` exports `{ fetch: handler.fetch, scheduled }` and `wrangler.jsonc` points `main` at it [docs]. TanStack's own page shows a slightly different wrapper (`createServerEntry`). Which form this version needs is [unverified].

Secrets arrive on `env`, set with `wrangler secret put` in production and `.dev.vars` locally [docs]. `.gitignore` already covers `.env*` but not `.dev.vars` [repo].

## 3. Stellar

### Accounts cost money to exist

An account is a ledger entry identified by an Ed25519 public key, written as a 56-character address starting with `G`. The network requires each account to hold a minimum balance of lumens (XLM): two base reserves for the account plus one per subentry. A base reserve is 0.5 XLM [docs]. An account that does not exist cannot receive anything: a payment to it fails with `PAYMENT_NO_DESTINATION`.

### Holding USDC needs a trustline

USDC is an issued asset, named by a code and an issuer account. Circle's testnet issuer is `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` [docs, Circle]. An account can hold an issued asset only after it creates a trustline to it with a Change Trust operation. A trustline is a subentry, so it adds 0.5 XLM to the minimum. A payment to an account without the trustline fails with `PAYMENT_NO_TRUST`.

So a new user needs 1.5 XLM locked before they can receive one cent of USDC, and they have none.

### Sponsored reserves solve that without giving XLM away

Another account, the sponsor, can carry the reserve for someone else's entries. It is done with a "sandwich" inside one transaction: Begin Sponsoring Future Reserves, then the operations being sponsored, then End Sponsoring Future Reserves. The sponsor signs for the first, and the sponsored account signs for the last [docs]. A sponsored account can be created with a starting balance of 0 [docs].

Two properties matter:

- **The new user's key must sign the transaction that creates their account.** Onboarding is therefore a signing round trip, not a server-only action.
- **The lumens stay the sponsor's.** The sponsor can revoke the sponsorship on its own [docs]. Funding a new account with real XLM instead would hand 1.5 XLM to anyone who signs up and merges the account away.

The guide shows a sandwich around a trustline. Creating the account and its trustline inside one sandwich is consistent with the text but has no worked example [unverified].

### Fees and fee bumps

Every transaction pays a fee in XLM, at least 100 stroops (0.00001 XLM) per operation, taken from the transaction's source account [docs]. Users hold no XLM, so they cannot pay it.

A fee-bump transaction wraps an already-signed inner transaction. A different account signs the wrapper and pays the fee. The inner transaction still uses its own source account's sequence number [docs]. The wrapper has its own hash: "a fee-bump transaction is found by its own hash, not the inner transaction's hash" [docs].

This fits payments well. The user's account is the source, so sequence numbers are per user and users do not contend with each other. The sponsor only signs the wrapper.

### Sequence numbers are what make a transaction single-use

Each account has a sequence number. A transaction must carry exactly the account's current number plus one, and applying it advances the number [docs]. Two consequences drive the whole design:

- **One signed transaction can be applied at most once.** After it is applied, its number is in the past.
- **Two different transactions with the same number are mutually exclusive.** At most one can ever apply.

A double send can therefore only happen one way: the same intent is signed twice with two different sequence numbers. Preventing that is the core of the design.

Whether a transaction that is rejected before inclusion (bad sequence, too late, low fee) consumes the number is not stated on the pages read. Protocol behaviour is that it does not, because it never enters a ledger [unverified]. A transaction that is included and then fails in an operation does consume it, and applies nothing: "one of the operations failed (none were applied)" [docs].

An account can have only one transaction consumed per ledger [docs]. Ledgers close every few seconds. Stellar RPC answers `TRY_AGAIN_LATER` when a transaction arrives "before an account's previously submitted transaction has settled" [docs].

### Time bounds make "it will never happen" provable

A transaction can carry a maximum time. After a ledger closes later than that, the transaction can never be included; it fails with `tx_too_late` [docs]. The docs encourage setting one "especially if you plan to resubmit".

This gives a clean rule for the unknown case. If the network does not know a transaction, and the latest ledger closed after the transaction's maximum time, the transaction is dead for good.

### Submission is asynchronous and idempotent

Stellar RPC is where the docs send new builders: "For any new builders coming to Stellar, Stellar RPC should be your starting point" [docs]. Horizon is still supported and has richer history, which the core flow does not need.

- `sendTransaction` only validates and enqueues. It returns `PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER` or `ERROR`. It never reports the final result [docs].
- `getTransaction(hash)` returns `SUCCESS`, `FAILED` or `NOT_FOUND`. Every answer, including `NOT_FOUND`, carries `latestLedgerCloseTime` [docs, tarball].
- A transaction's hash is fixed once the transaction is built. It does not depend on the signatures [docs, by the pre-authorized transaction text].
- RPC keeps about 7 days of history by default [docs].

So the same signed bytes can be sent any number of times, and the answer "did it happen" comes from one lookup that also carries the ledger clock. A submit response is only a hint. An `ERROR` with a bad-sequence code is exactly what a duplicate submit of an already-applied transaction looks like.

Whether `getTransaction` finds a fee-bump by its inner hash is not documented [unverified]. The design stores and queries the wrapper's hash, so it does not depend on the answer.

### Memos

A memo is a field on the transaction, not on an operation. Types are text up to 28 bytes, a 64-bit id, and two 32-byte hashes [docs]. Exchanges use it to route a deposit into a pooled account. The core flow sets no memo, but the transaction-building code must have a place for one, because exchange withdrawals come next.

### Why not contract accounts

A contract account is a smart contract that acts as a wallet, addressed with `C…`. It can be controlled by a passkey and needs no trustline. The official docs were checked for it as a candidate base:

- "A transaction that invokes a contract must set MEMO_NONE" [docs]. A memo cannot accompany a transfer from a contract account. The workaround is a muxed destination address, which each exchange must support.
- "Transfers from contracts are not supported by exchanges today" [docs, contract accounts page]. Another official page describes how exchanges can support them. The two disagree, which makes it a risk, not a foundation.
- "Contract accounts can't pay their own transaction fees", and a relayer service must submit for them. The hosted Launchtube relayer is retired; the replacement is the OpenZeppelin Relayer [docs].
- Sponsored reserves do not cover contract storage [docs].

Withdrawal to an exchange with a memo is a named feature of this product. Classic accounts do it natively. Agent smart accounts are also named, so the account type must not leak out of the Stellar module.

### Claimable balances

A claimable balance is money parked on the ledger for named claimants, with time predicates such as "claimable before T" and "claimable by the sender after T" [docs]. That is the native primitive for payment links and auto-refunding pots. It is a classic-account feature. Nothing in the core flow uses it, but it confirms that classic accounts are the right base for what comes later.

### Testnet

Passphrase `Test SDF Network ; September 2015`, RPC at `https://soroban-testnet.stellar.org` [docs]. Testnet is wiped two to four times a year; the next reset is 2026-12-16 [docs]. After a reset every account is gone while the database still lists them. Friendbot gives 10,000 test XLM to fund the sponsor. Circle's faucet gives 20 test USDC per address every two hours, to an account that already has the trustline [docs].

## 4. The JavaScript SDK and the browser

`@stellar/stellar-sdk` is at 17.4.0 [tarball]. It is not installed. Facts read from the package:

- It defaults to native `fetch` and no longer uses `Buffer`. Its README has a Cloudflare Workers section and says no HTTP adapter is needed.
- The old `@stellar/stellar-base` is folded in. `@stellar/stellar-sdk/base` exports only the offline parts: `TransactionBuilder`, `Operation`, `Asset`, `Memo`, `Keypair`, `StrKey`.
- `TransactionBuilder.fromXDR(envelope, passphrase)` parses a transaction. `transaction.hash()` returns the 32 bytes to sign. `transaction.addSignature(publicKey, base64)` verifies the signature against the hash and throws if it is wrong.
- `TransactionBuilder.buildFeeBumpTransaction(feeSource, baseFee, inner, passphrase)` builds the wrapper.
- `rpc.Server` has `getAccount`, `getTrustline`, `sendTransaction` and `getTransaction`.

Bundle cost was measured with esbuild, minified, tree-shaken, browser target [measured]. These are estimates; the real Vite build may differ.

| What the browser loads                                | Minified | Gzip   |
| ----------------------------------------------------- | -------- | ------ |
| `@stellar/stellar-sdk/base`, parse or build a payment | 296 KB   | 72 KB  |
| Whole SDK, published browser bundle                   | 829 KB   | 178 KB |
| `effect/Effect` only                                  | 28 KB    | 10 KB  |
| `effect/Effect` + `effect/Schema`                     | 74 KB    | 25 KB  |
| `effect/Effect` + `effect/crypto` signing             | 57 KB    | 20 KB  |
| Same code imported from the `effect` root             | 378 KB   | 122 KB |

Two conclusions. The phone can afford to parse a transaction before signing it, if the 72 KB is loaded only when the user creates a wallet or sends. And browser code must import Effect by subpath (`effect/Effect`), as the repo's server code already does; the root import costs five times more.

## 5. What this forces

1. **The server must be able to finish a payment alone.** The app may close right after the user confirms. Something durable outside the phone must hold the signed transaction.
2. **The phone must sign, and should know what it signs.** The key never leaves the device. Signing a bare hash would let a faulty server take everything.
3. **One intent maps to one signed transaction, forever.** That is the only way to rule out a double send, given how sequence numbers work.
4. **"Did it happen" is read from the ledger.** Never from a submit response, never from a timeout.
5. **Database decisions are conditional writes.** Because of connection pooling and query caching.
6. **Clients are built per request.** Because of Workers.
7. **The account type stays private to one module.** Because memos need classic accounts now and agents need contract accounts later.

## 6. Not verified

- Account creation and trustline in a single sponsorship sandwich.
- That a transaction rejected before inclusion leaves the sequence number untouched.
- Whether the Vite client build fails or only warns when browser code imports a server-only module.
- Which custom server entry form TanStack Start 1.169.5 needs for a `scheduled` handler.
- That a non-extractable Ed25519 `CryptoKey` can be stored in IndexedDB on the target Android browsers. The web platform specifies it; it was not tested.
- Real bundle sizes under the project's Vite build.
- CPU time of drafting, verifying and signing inside a Worker.
