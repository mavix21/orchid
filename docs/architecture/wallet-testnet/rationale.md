# Rationale: core wallet flow on testnet

Facts are in `ground.md`. Types and signatures are in `sketch.md`. Key backup and recovery are in `backup.md`.

## Problem

A person with no crypto and a cheap Android phone must create a wallet under a username, see a USDC balance, and pay another username. The key stays on the phone. A payment happens once or provably not at all, even when the network drops or the app closes mid-send.

## Usage (caller's view)

The UI imports one value. Each call returns a tagged outcome and never throws.

```ts
import { wallet } from "@/wallet";

const overview = await wallet.overview(); // Holding | NoWallet | Offline
const created = await wallet.create("maria"); // Opened | UsernameTaken | …
const sent = await wallet.send("@maria", "5.00"); // Settled | Pending | Failed | …
```

The caller never retries, polls, or sees a transaction.

## Shape

**Data first.** The ledger is the truth for balances and for whether a payment happened. Postgres holds what the ledger cannot: which username owns which address, and which signed transaction belongs to which intent. The phone stores a signing handle and an encrypted copy of its seed. The server stores one encrypted copy of the seed per passkey and cannot decrypt it.

**Load-bearing decisions.**

1. The server drafts every transaction. The phone checks the draft does exactly what was asked and returns only a signature.
2. One transfer id maps to one signed transaction, forever, stored before it is first submitted.
3. One sender has at most one signed, unfinished transfer, enforced by a unique index. That also removes sequence-number races.
4. A final state is written only from ledger evidence. `Failed` means the ledger clock passed the transaction's time bound.
5. `open` and `transfer` are replayable. Retry, resume and status are the same call.
6. Classic accounts; the sponsor carries reserves and fees.

**Invariants in types.** `Approval` has no envelope field. `submit` returns `void`. `conclude` rejects `Undecided`. A sealed envelope exists only on `Authorized`. The key has no raw sign method.

**Validation** lives in the contract schemas, run where input enters: user text on the phone, the wire on the server. Services accept only branded types.

**Deliberately not done.** Sessions, activity history, memos, payment links, pots, agent accounts, channel accounts (so about one sign-up per ledger), mainnet.

**Interface depth.** The UI sees three functions; the server exposes four operations. Behind them sit sponsorship, trustlines, fee bumps, sequence numbers, time bounds, idempotency, reconciliation and the database. None of it appears in a signature a caller can see.

## Synthesis decision

**Base: A, the server ledger.** Only it can finish a payment after the phone is gone.

**Grafted from B, the device outbox:** the phone verifies before it signs; the transfer id is minted on the phone before any network call; settlement and balances are read from the chain.

**Grafted from C, contract accounts:** the account type is private to one module, so one can be added later behind the same port.

**Grafted from the relay alternative:** the package `exports` map has two entries, `"."` at `./src/index.ts` and `"./server"` at `./src/server/index.server.ts`. Every server file is named `*.server.ts`, so Start import protection fails `bun run build` when client code imports one, including a relative import from `device/*` into `server/*`. The two entries are the only public surface, so `@workspace/wallet/src/...` fails module resolution in typecheck and in build. No `paths` alias may be added for this package; the existing `@workspace/ui/*` alias does bypass `exports`. The first implementation step proves, with a real build, that a client import of server code fails.

**Rejected:** B's outbox as the source of truth. C as the base, because a contract call cannot carry a memo and exchanges do not reliably credit one.

## Tradeoffs accepted

- We accept a 72 KB (gzip) Stellar chunk on first send in exchange for a phone that never signs blind.
- We accept one in-flight payment per sender in exchange for a no-double-send rule that is trivially true.
- We accept up to two minutes of "on its way" for a payment that never reaches the network in exchange for never guessing an outcome.
- We accept that the server could misdirect a payment by lying about a username in exchange for usernames at all. It cannot change the amount or touch the rest of the balance.
- We accept a second package in exchange for a boundary the build enforces.
- We accept that the seed is in page memory at creation, recovery and phrase reveal in exchange for a phrase the user can take to another wallet.

## Alternatives considered

**B, the device outbox.** The phone builds and submits; the server resolves usernames and co-signs. It lost on depth: the UI call looks the same, but the phone coordinates five network steps, the server's `cosign(envelope)` exposes one internal stage, and transaction rules live twice. A cached old app keeps building to old rules.

**A staged server API** (`prepare`, `submit`, `status`). Same base, shallower: three methods for one operation, and the caller owns their order.

## Decisions

- **Usernames.** `[a-z0-9_]`, 3-20 characters, lowercase, and permanent. Once claimed, a name cannot be changed or released.
- **Registration.** Open, with no invite and no quota for now.
- **Cloudflare.** Try the Workers free plan first and measure CPU. Upgrade only if the measurement requires it.
- **Browser minimum.** Native Ed25519 is acceptable: Chrome 137, Safari 17, Firefox 129. Passkey backup has its own, higher floor (the WebAuthn PRF extension). Phones below it get a device-only wallet; see `backup.md` section 6.
- **Unauthenticated reads.** Balance and overview without authentication are acceptable on testnet.
- **Testnet funding.** A fund button in the app. Friendbot gives only testnet XLM. Test USDC comes from an Orchid-funded endpoint.
- **Key backup.** Decided in `backup.md`. A SEP-0005 phrase is the source of truth, is never shown at sign-up, and is encrypted with a key from the passkey's PRF output. Two things block implementation: the passkey domain is not defined, and PRF support on low-end Android must be tested on real phones first.

## Open questions and risks

1. May Hyperdrive query caching be disabled? With it on, a status can read a minute stale.
2. Should the tables live inside `packages/wallet`, leaving `packages/db` as the driver only? The scaffold expected them in `packages/db/src/schema.ts`.
3. Who funds and guards the sponsor key? Each wallet locks 1.5 XLM.
4. Can account creation and the trustline share one sponsorship sandwich? The docs imply it; no example shows it.
5. Does Cloudflare's documented `scheduled` entry work with TanStack Start 1.169.5 as written?
6. Does the build fail when browser code imports `@workspace/wallet/server`? If not, what should enforce it?
7. Should the app detect a testnet reset (next: 2026-12-16) and clear its tables?
8. May `drizzle-kit` be added for migrations?
9. A user who exports the phrase can remove the USDC trustline or merge the account in another wallet. The wallet is then `active` in the database with no balance on the ledger. What should `overview` answer? See `backup.md` section 7.

## Next implementation step

Prove, with a real `bun run build`, that a client import of server code fails. Then prove the Stellar half alone with a testnet script that drafts, signs, sponsors and settles one opening and one fee-bumped USDC payment. The script measures free-plan CPU and tests the sponsorship sandwich.
