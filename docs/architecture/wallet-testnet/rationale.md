# Rationale: core wallet flow on testnet

Platform constraints are in [ground.md](ground.md). Behaviour and current limits are in the [wallet README](../../../packages/wallet/README.md). Key backup and recovery are in [backup.md](backup.md).

## Problem

A person with no crypto and a cheap Android phone must create a wallet under a username, see a USDC balance, and pay another username. The key stays on the phone. A payment happens once or provably not at all, even when the network drops or the app closes mid-send.

## Shape

**Data first.** The ledger is the truth for balances and for whether a payment happened. Postgres holds what the ledger cannot: which username owns which address, and which signed transaction belongs to which intent. The phone holds the signing key. With passkey backup, it also stores an encrypted copy of its seed, and the server stores one encrypted copy per passkey that it cannot decrypt.

**Load-bearing decisions.**

1. The server drafts every transaction. The phone checks each draft does exactly what was asked and returns only signatures (opening first, then recovery from the confirmed account sequence, behind one user action).
2. One transfer id maps to one signed transaction, forever, stored before it is first submitted.
3. One sender has at most one signed, unfinished transfer, enforced by a unique index. That also removes sequence-number races.
4. A final state is written only from ledger evidence. `Failed` requires an included rejection or expiry proved while RPC history covers the inclusion window. A consumed sequence also concludes rejected when complete retained inner-hash absence evidence covers that consumption; missing history stays undecided.
5. `open` and `transfer` are replayable. Retry, resume and status are the same call.
6. Classic accounts; the reserve sponsor carries reserves and the fee payer pays fees.

**Invariants in types.** `Approval` has no envelope field. `submit` returns `void`. `conclude` rejects `Undecided`. A sealed envelope exists only on `Authorized`. The key has no raw sign method.

**Validation** lives in the contract schemas, run where input enters: user text on the phone, the wire on the server. Services accept only branded types.

**Deliberately not done.** Sessions, activity history, hash/return memos, payment links, pots, agent accounts, channel accounts (so about one sign-up per ledger), mainnet.

**Interface depth.** The UI sees three functions; the server exposes three operations plus a scheduled sweep; passkey backup adds two operations. Behind them sit sponsorship, trustlines, fee bumps, sequence numbers, time bounds, idempotency, reconciliation and the database. None of it appears in a signature a caller can see.

## Synthesis decision

Three bases were compared: A, a server ledger that holds and finishes every transfer; B, a device outbox where the phone builds and submits and the server only co-signs; C, contract accounts submitted by a relayer.

**Base: A, the server ledger.** Only it can finish a payment after the phone is gone.

**Grafted from B:** the phone verifies before it signs; the transfer id is minted on the phone before any network call; settlement and balances are read from the chain.

**Grafted from C:** the account type is private to one module, so a contract account can be added later behind the same port.

**Package boundary.** The package `exports` map has two entries, `"."` at `./src/index.ts` and `"./server"` at `./src/server/index.server.ts`. Every server file is named `*.server.ts`, so Start import protection fails `bun run build` when client code imports one, including a relative import from `device/*` into `server/*`. The build checks both denied imports and a working client transport. The two entries are the only public surface, so `@workspace/wallet/src/...` fails module resolution in typecheck and in build. No `paths` alias may be added for this package; the existing `@workspace/ui/*` alias does bypass `exports`.

**Rejected:** B as the base, because the phone would coordinate every network step, transaction rules would live twice, and a cached old app would keep building to old rules. C as the base, because a contract call cannot carry a memo and exchanges do not reliably credit one. A staged server API (`prepare`, `submit`, `status`), because the caller would own the order of three calls for one operation.

## Tradeoffs accepted

- We accept a 72 KB (gzip) Stellar chunk on first send in exchange for a phone that never signs blind.
- We accept one in-flight payment per sender in exchange for a no-double-send rule that is trivially true.
- We accept up to two minutes of "on its way" for a payment that never reaches the network in exchange for never guessing an outcome.
- We accept that the server could misdirect a payment by lying about a username in exchange for usernames at all. It cannot change the amount or touch the rest of the balance.
- We accept a second package in exchange for a boundary the build enforces.
- We accept that the seed is in page memory at creation, recovery and phrase reveal in exchange for a phrase the user can take to another wallet.
- We accept that an opening abandoned before recovery signing keeps its reserve locked, because the server cannot produce the missing signature.

## Decisions

- **Usernames.** `[a-z0-9_]`, 3-20 characters, lowercase, and permanent. A name is bound when the signed opening is stored. Once bound, it cannot be changed, released or used by another address. Names containing `orchid`, and reserved words such as `support`, `admin`, `soporte` and `ayuda`, cannot be bound.
- **Registration.** Open, with no invite and no quota for now.
- **Cloudflare.** Try the Workers free plan first and measure CPU. Upgrade only if the measurement requires it.
- **Hyperdrive.** Query caching is disabled on the wallet's configuration; deploys through `apps/web` check it.
- **Schema location.** Tables and generated migrations live in `packages/wallet`; `packages/db` remains the driver.
- **Browser minimum.** Native Ed25519 is acceptable: Chrome 137, Safari 17, Firefox 129. Passkey backup has its own, higher floor (the WebAuthn PRF extension). Phones below it get a device-only wallet; see [When PRF is not available](backup.md#when-prf-is-not-available).
- **External memos.** A text or numeric ID memo is required only for addresses known to belong to exchanges that need one (an evidence-backed server registry, empty until an address is verified); other external sends accept an optional memo. Orchid sends carry none.
- **Unauthenticated reads.** Balance and overview without authentication are acceptable on testnet.
- **Testnet funding.** A fund button in the app. Friendbot gives only testnet XLM. Test USDC comes from an Orchid-funded endpoint.
- **Testnet reset.** Tables are preserved across a reset, missing wallets are marked recovered and reopen under the same username and key, and new transfers are scoped to the new epoch.
- **Sponsorship roles.** The reserve sponsor only sponsors account and trustline reserves with CAP-33 `beginSponsoringFutureReserves`; the fee payer only pays fees through CAP-15 fee bumps. They are separate key roles in code and configuration, although both may use the same key on testnet. Mainnet can split them without code changes. Keep the sponsor balances small, top them up from a cold account, store keys in Cloudflare secrets, and alert on low balances.
- **Public opening.** Before public access, protect `open` with Turnstile or per-IP limits and a daily reserve-sponsor cap.
- **Key backup.** Decided in [backup.md](backup.md). A SEP-0005 phrase is the source of truth, is never shown at sign-up, and is encrypted with a key from the passkey's PRF output. Demo wallets are disposable until the real domain exists; see [Decisions](backup.md#decisions) there.
