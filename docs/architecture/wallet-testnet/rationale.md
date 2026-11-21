# Rationale: wallet server on testnet

Platform constraints are in [ground.md](ground.md). Behaviour and current limits are in the [wallet README](../../../packages/wallet/README.md).

## Problem

A person with no crypto must open a wallet under a username, hold USDC, and pay another username or an external address. A payment happens once or provably not at all, even when the network drops or the caller disappears mid-send.

## Shape

The ledger is the truth for balances and for whether a payment happened. Postgres holds what the ledger cannot: which username owns which address, and which signed transaction belongs to which intent.

1. The server drafts every transaction and accepts back only a signature: `Approval` has no envelope field.
2. One transfer id maps to one signed transaction, stored before it is first submitted.
3. One sender has at most one signed, unfinished transfer, enforced by a partial unique index. That also removes sequence-number races.
4. A final state is written only from ledger evidence. `submit` returns `void`, and `conclude` rejects `Undecided`.
5. `open` and `transfer` are replayable: retry, resume and status are the same call.
6. Classic accounts; the reserve sponsor carries reserves and the fee payer pays fees through fee bumps.

## Synthesis decision

**Base: a server ledger.** The server stores and finishes every transfer, so a payment completes after the caller is gone. Settlement and balances are read from the chain. The Stellar account type is private to the `stellar/` and `Chain` modules.

**Rejected:** a device outbox, where the phone builds and submits and the server only co-signs, because transaction rules would live twice. Contract accounts as the base, because a contract call cannot carry a memo. A staged `prepare`/`submit`/`status` API, because the caller would own the order of three calls for one operation.

**Package boundary.** `exports` has two entries, `"."` and `"./server"`, and every server file is named `*.server.ts`. The root build runs production builds that must reject a server, relative and private import from client code, and one client transport build that must pass. Add no `paths` alias for this package.

## Tradeoffs accepted

- One in-flight payment per sender, in exchange for a no-double-send rule that is trivially true.
- Up to two minutes of pending for a payment that never reaches the network, in exchange for never guessing an outcome.
- The server could misdirect a payment by lying about a username, in exchange for usernames at all. It cannot change the amount.
- An opening abandoned before recovery signing keeps its reserve locked, because the server cannot produce the missing signature.

## Decisions

- **Usernames.** `[a-z0-9_]`, 3-20 characters, lowercase and permanent, bound when the signed opening is stored. Names containing `orchid` and reserved words cannot be bound.
- **Registration.** Open, with no invite or quota.
- **Schema location.** Tables and migrations live in `packages/wallet`; `packages/db` is the driver.
- **External memos.** Required for addresses in the known-exchange registry and for accounts that publish the SEP-29 `config.memo_required` data entry as `1`; other external sends accept an optional text or ID memo. Orchid sends carry none.
- **Unauthenticated reads.** `overview` takes an address without authentication on testnet.
- **Testnet reset.** Tables survive a reset; missing wallets are marked recovered and reopen under the same username, and transfers are scoped to the new epoch.
- **Sponsorship roles.** Reserve sponsor and fee payer are separate key roles in configuration, so mainnet can split them without code changes.
