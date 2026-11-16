# Wallet on testnet: rationale

## Problem

A person in Peru with a low-end Android phone picks `@maria`, sees a USDC balance, and pays `@juan`. They hold no XLM, pass no KYC, and keep their own key. Signal drops, double taps and the app being killed mid-send must never move money twice and never leave the user unsure whether money moved.

## Usage (caller's view)

UI code imports one service, `Wallet` from `@workspace/wallet`, and runs it through a `ManagedRuntime`. Its five members are `profile` (local), `create(username)`, `overview`, `preview(to, amount) → TransferDraft` and `send(draft) → Transfer`. Inputs are raw strings, and the package parses them. Errors are tagged and handled with `catchTags`. A send resolves to the status `sending | pending | sent | not_sent`. The app's only wiring is one server function (`callWallet`) and one runtime line. See sketch §1.

## Shape

- **Data first.**
  - Postgres stores `wallets` (username ↔ address) and `transfers`, keyed by the inner transaction hash and holding the one fee-bumped envelope.
  - The device stores a keystore (key and profile) and an outbox (at most one unacknowledged envelope).
  - Balances are read only from the chain.
- **Load-bearing decisions.**
  - The device builds and signs payments. The server checks them, fee-bumps once, submits and records.
  - The sponsor creates a zero-XLM account with a USDC trustline in one sandwich.
  - Stellar RPC is used, not Horizon.
  - One `*.server.ts` package serves both sides through a single server function and an exhaustive call union.
- **Invariants in types.**
  - `TransferDraft` cannot be built outside `preview`, so the address the user saw is the address that gets signed.
  - `Usdc` is a branded bigint in ledger units.
  - `WalletOffline` means nothing irreversible happened.
  - Replies are keyed by call tag with `satisfies`.
- **Where validation lives.**
  - User text is parsed once in `values.ts`.
  - Wire input goes through `Schema.toStandardSchemaV1(WalletCall)` as the Start validator.
  - Transaction policy is checked in `stellar/*-tx.ts`: one file per layout, holding both its build and check halves.
- **Deliberately does not do:**
  - cache balances or do offline reads;
  - authenticate reads;
  - run a cron or queue;
  - support multiple devices per key;
  - back up the key;
  - use memos, SEP-2 federation or smart accounts;
  - show incoming payments from outside Orchid in activity (they still count in the balance).
- **Interface depth.** The public surface is 5 members plus 2 server exports. Behind it sit key custody, XDR, sequencing, deadlines, sponsorship, fee bumps, RPC status mapping, retries, idempotency and persistence. That is the deepest of the candidates.

## Synthesis decision

The base is **A, Relay**.

- **Grafted from C, Orchestrator:** the server owns transfer status and drives each acknowledged transfer to a result, and enrollment is server-built and device-checked.
- **Grafted from B, Direct:** the chain is the source of truth for balances, and the content hash is the idempotency key, not a client token.
- **Grafted from D, Smart account:** no Stellar type crosses the package boundary.
- **Rejected:**
  - B leaks RPC and XDR into the client, makes "co-sign" a shallow method, and needs a second submit path later.
  - D cannot put a memo on SAC transfers, which breaks Lemon withdrawals.
  - C costs an extra round trip on every send.

## Tradeoffs accepted

- We accept **one send in flight per account** (about 5 s between sends) in exchange for at-most-once delivery by construction.
- We accept **permanent usernames** in exchange for drafts that cannot be redirected.
- We accept **unauthenticated reads by address** in exchange for no session system on testnet.
- We accept **the device bundling `@stellar/stellar-sdk/base`** in exchange for never signing bytes the server wrote, with enrollment as the one exception.
- We accept **sponsor-sourced enrollment, at most about one per ledger**, in exchange for zero-XLM onboarding.

## Alternatives considered

- **C, Orchestrator.** The server builds every transaction, and the device checks and signs. Its public surface is the same size as A's. But each send needs prepare and then submit, and adds an `awaiting_signature` state and a redundant client idempotency key. It lost because it adds a state and a round trip for no extra hidden complexity.
- **B, Direct.** It lost on depth: the caller-side module has to coordinate sequence, co-sign, submit and poll.
- **Effect RPC instead of one Start server function.** Every entry point is `@stability unstable`, and it puts an HttpClient in the browser bundle.

## Open questions and risks

1. Is losing funds when site data is cleared acceptable on testnet, or do you want key export, a mnemonic, or passkey-PRF encryption now?
2. Username rules: `[a-z0-9_]{3,20}`, case-insensitive and permanent. Should `ñ`, reserved names or renames be allowed?
3. How do new users get test USDC: an Orchid airdrop at enrollment, or Circle's faucet?
4. Should wallet tables live in `packages/wallet`, which enforces one writer, contrary to the README's "add tables to packages/db"? And which migration tool should we use (drizzle-kit is not installed)?
5. Does Start keep the `.validator()` argument in the client build? (unverified) If it does, import protection would fail the build, and the validator would move to a schema-only entry.
6. Does import protection apply to files in a Bun-symlinked workspace package, given its `node_modules` exclusion? (unverified)
7. What are the Worker plan's CPU and subrequest limits? Polling `getTransaction` is budgeted at about 2 ledgers.
8. Do `@stellar/stellar-sdk/rpc` (workerd) and `/base` plus Effect (browser) fit the low-end Android budget? (unverified; needs measuring)
9. Testnet resets on **2026-12-16** and wipes every account while our rows survive. When is the demo, and should we add a reset script?
10. Is one sponsor key, in a Wrangler secret, acceptable for both reserves and fees?

## Next implementation step

Scaffold `packages/wallet` with its two-entry `exports` map, a stub `index.server.ts`, and one `callWallet` server function. Then confirm with `bun run build` that a client import of the server entry fails and the validator survives, before writing any wallet logic.
