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

1. The server drafts every transaction. The phone checks each draft does exactly what was asked and returns only signatures (opening first, then recovery from the confirmed account sequence, behind one user action).
2. One transfer id maps to one signed transaction, forever, stored before it is first submitted.
3. One sender has at most one signed, unfinished transfer, enforced by a unique index. That also removes sequence-number races.
4. A final state is written only from ledger evidence. `Failed` requires an included rejection or expiry proved while RPC history covers the inclusion window.
5. `open` and `transfer` are replayable. Retry, resume and status are the same call.
6. Classic accounts; the reserve sponsor carries reserves and the fee payer pays fees.

**Invariants in types.** `Approval` has no envelope field. `submit` returns `void`. `conclude` rejects `Undecided`. A sealed envelope exists only on `Authorized`. The key has no raw sign method.

**Validation** lives in the contract schemas, run where input enters: user text on the phone, the wire on the server. Services accept only branded types.

**Deliberately not done.** Sessions, activity history, memos, payment links, pots, agent accounts, channel accounts (so about one sign-up per ledger), mainnet.

**Interface depth.** The UI sees three functions; the server exposes three operations plus a scheduled sweep in this step; passkey backup adds two operations later. Behind them sit sponsorship, trustlines, fee bumps, sequence numbers, time bounds, idempotency, reconciliation and the database. None of it appears in a signature a caller can see.

## Synthesis decision

**Base: A, the server ledger.** Only it can finish a payment after the phone is gone.

**Grafted from B, the device outbox:** the phone verifies before it signs; the transfer id is minted on the phone before any network call; settlement and balances are read from the chain.

**Grafted from C, contract accounts:** the account type is private to one module, so one can be added later behind the same port.

**Grafted from the relay alternative:** the package `exports` map has two entries, `"."` at `./src/index.ts` and `"./server"` at `./src/server/index.server.ts`. Every server file is named `*.server.ts`, so Start import protection fails `bun run build` when client code imports one, including a relative import from `device/*` into `server/*`. These entries are implemented in `packages/wallet`; the build verifies both denied imports and a working client transport. The root also exposes the device client. The two entries are the only public surface, so `@workspace/wallet/src/...` fails module resolution in typecheck and in build. No `paths` alias may be added for this package; the existing `@workspace/ui/*` alias does bypass `exports`. The first implementation step proves, with a real build, that a client import of server code fails.

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
- **Sponsorship roles.** The reserve sponsor only sponsors account and trustline reserves with CAP-33 `beginSponsoringFutureReserves`; the fee payer only pays fees through CAP-15 fee bumps. Configure separate key roles in code and configuration, although both may use the same key for the hackathon/testnet. Mainnet can split them without code changes. Separate keys isolate an empty or compromised fee payer from reserve sponsorship and vice versa. Keep the sponsor balances small, top them up from a cold account, store keys in Cloudflare secrets, and alert on low balances.
- **Public opening.** Before public access, protect `open` with Turnstile or per-IP limits and a daily reserve-sponsor cap.
- **Key backup.** Decided in `backup.md`. A SEP-0005 phrase is the source of truth, is never shown at sign-up, and is encrypted with a key from the passkey's PRF output. Non-disposable passkeys require the real domain and PRF testing on cheap Android phones; demo wallets are disposable (see D7).

## Environments and databases

Plan, not yet implemented: one Neon project with root branch `main` for production, a copy-on-write child `dev` with its own connection string for local work, and an optional `testnet` branch. The free plan includes 10 branches per project. Resetting dev with `neon branches reset dev --parent` replaces its data and schema with its parent's. See [Neon reset](https://neon.com/docs/guides/reset-from-parent) and [plans](https://neon.com/docs/introduction/plans).

Local `wrangler dev` connects directly to Neon dev using the uncommitted `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` environment variable; `hyperdrive[].localConnectionString` is an alternative. Hyperdrive pooling and caching do not apply locally. Each deployed Wrangler environment declares its own `hyperdrive` binding named `HYPERDRIVE`, with its own Hyperdrive ID pointing to its branch; bindings are not inherited. See [local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/) and [environments](https://developers.cloudflare.com/workers/wrangler/environments/).

A Neon dev branch cloned from main copies seed ciphertexts and, later, the phone directory; treat the clone accordingly.

`wrangler dev --remote` ignores the local connection string and uses the deployed Hyperdrive configuration, which may point to production.

## Open questions and risks

1. Answered: disable Hyperdrive query caching with `wrangler hyperdrive update <id> --caching-disabled` ([Cloudflare](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)).
2. Answered: tables and generated migrations live inside `packages/wallet`; `packages/db` remains the driver.
3. Who operates sponsor funding and alerts? Each wallet locks 1.5 XLM in reserves.
4. Answered: account creation and the trustline share one sponsorship sandwich; see the testnet spike results below.
5. Answered: the custom fetch + scheduled Worker entry builds and its scheduled handler succeeds in local workerd.
6. Answered: production builds reject public and relative server imports. Start import protection explicitly includes the wallet workspace.
7. Answered: preserve tables, mark missing wallets recovered, and scope new transfers to the known testnet epoch.
8. Answered: owner requested official Drizzle Kit migration generation; version 1.0.0-rc.5 matches the installed ORM.
9. Answered: missing account or USDC trustline returns `NeedsReopening`, marks the row `recovered`, and `open` repairs it with the same username and key before repeating recovery signing.

## Send-to-phone roadmap

The escrow claim requires both Orchid's attester signature and the preimage of a claim-secret hash set at deposit. The sender's device generates the secret and shares it in the recipient notification; Orchid never sees it. Attester-only claims would be custody: a leaked key could drain every open escrow, and the contract has no admin. The attester is a third key role, separate from the reserve sponsor and fee payer; it is never a Stellar account key.

Use persistent contract storage, cap expiry in the contract (default 30 days), reject duplicate `escrow_id` or key by `(sender, escrow_id)`, and domain-tag the signed payload. Soroban from a zero-XLM classic account via fee bump remains unproven. A Soroban transaction permits one operation and no memo: open and claim are separate transactions, and the device verifies the contract-call layout before signing.

Open gaps: refund can fail if the sender removes the trustline or is merged; resolve a recipient once and pin it in the draft if registration races submission; OTP proves phone control, not address ownership, so bind the address with a device signature; account for SIM swap or recycling during expiry. Sending to a number reveals user existence: rate limit per funded sender. Store a versioned pepper outside Postgres; send OTP only when money is waiting or an account exists. Phone tables are deferred; server data seams are in `sketch.md`.

## Pending spikes

1. Test PRF on real cheap Android devices on the final domain.
2. Completed: the build runs permanent negative imports and a positive transport check.
3. Fee-bump a Soroban call from a zero-XLM G account pulling USDC; record who pays what.
4. Claim escrow with an attester signature and secret; test refund after expiry with the sender's trustline removed.
5. Test a recovery transaction with `maxTime` and re-opening a merged account under the same username.

## Testnet spike results

Stellar testnet verified that `createAccount` with 0 XLM and the USDC `changeTrust` fit in one `beginSponsoringFutureReserves` / `endSponsoringFutureReserves` sandwich. The reserve sponsor co-signs the inner transaction and carries 1.5 XLM in reserves per account with a trustline. A user with exactly 0 XLM [paid USDC through a fee bump](https://stellar.expert/explorer/testnet/tx/abbdefb28bc8c0c08584e5493a8799e64e217ea4ad9ad4444aa5d1cb7832bdb9) paid by the fee payer.

For abandoned accounts, the device pre-signs a recovery transaction at creation: source is the user, sequence is current + 1, and `minTime` is creation + delay (about 90 days in production). It sets the USDC trustline limit to 0 and merges the account into the reserve sponsor; Orchid stores it unsubmitted. Testnet rejected it with `tx_too_early` before `minTime`; afterward it [succeeded and released the sponsored reserve](https://stellar.expert/explorer/testnet/tx/3b540ba1ab0a6619667cec39ec57381e8798b7bd9d6cc516833173eb91f158f3). If the user has transacted, it fails with `tx_bad_seq`. If the account holds USDC, it fails atomically (`op_invalid_limit` / `op_has_sub_entries`), leaving funds intact; the consumed sequence permanently invalidates it.

Recovery covers only accounts that never transacted, such as curiosity sign-ups. There is no re-signing after each transaction for now. The stored recovery transaction must also have `maxTime` (the spike used 0, meaning no expiry). Check balance and sequence before submitting: a failed submit consumes the sequence and costs a fee. Mark a merged wallet `recovered` and allow its user to re-open under the same username. CAP-21 `minSeqNum` / `minSeqAge` is an untested alternative, not adopted. The spike script was removed; it remains in history at commit `18b10998a397e816903f193981bfbfd3e95327a5`.

## Accepted opening limitation (2026-11-16)

Account creation precedes recovery signing because the initial sequence depends on its inclusion ledger. The wallet stays `opening` until signed recovery is stored; the next app session resumes the same `open` operation. If the device never returns, the reserve remains locked. This is accepted: the server cannot manufacture the missing signature.
