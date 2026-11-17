# Fable review verification

## Re-review round

The four code findings in the owner's re-review were verified against `35331cc`/`dedc64a` and addressed in `7b8b673`. The latest-receipt finding needs one qualification: authorized rows already had priority; a newer unsigned draft could hide a concluded receipt.

- Stale proposals now compare their sequence to the account before returning a draft, immediately before authorization, and after reconciling a completed `SlotTaken` holder. Replacements compare the previous proposed envelope; they cannot replace a concurrent signed authorization. The old approval is never reused to authorize the replacement.
- A consumed sequence reaches rejected only when an inner-hash `NOT_FOUND` has retained history from the transaction's `minTime` through the observed account ledger. That proves this transaction absent while another transaction consumed its sequence, and releases the sender slot. Insufficient history or lagging ingestion remains undecided. `Expired` still requires the sender sequence below the transaction sequence and full time-window coverage.
- `reopening` returns `NeedsReopening`. Latest selects authorized, settled or failed rows; proposed rows cannot hide a receipt.
- External orders optionally carry the official SDK's text/id memo kinds. External sends require a nonempty text memo (1–28 UTF-8 bytes) or canonical decimal uint64 ID. Orchid profiles refuse memos. Boundary schemas reject unsupported/invalid memo values and malformed Unicode; the SDK builds the memo, and the strict reader, signature, order JSON and receipts retain it. No database migration is needed: official `drizzle-kit generate` reports no schema changes.

The official RPC reference does not explicitly promise fee-bump inner-hash aliasing. This round inspected the [official implementation](https://github.com/stellar/stellar-rpc/blob/cacf18510507762fe3ae827f237658d4c61b6456/cmd/stellar-rpc/internal/rpcv1/sqlitedb/transaction.go#L85), which indexes both hashes. The new absence proof relies on that index and the RPC's reported history range. A fresh live test also resolved an inner transaction submitted under a different fee payer while the original outer hash remained `NOT_FOUND`.

## Verification

All required commands exited 0. [checks.txt](./checks.txt) preserves their complete command output, including nonfatal Turbo cache permission warnings. Package tests use the documented disposable PostgreSQL 17.12 container and apply the official Effect Postgres migrator twice. The final suite has 38 passing tests, 0 failures and 529 assertions; three real negative Vite builds and a positive transport build also pass.

The fresh `testnet:verify` run finished at `2026-11-17T00:01:48.063Z`. Fresh keys were generated only into gitignored `.dev.vars`; the previous env file was renamed without reading it. Friendbot funded separate sponsor/fee-payer keys and an unsponsored outsider. No production database, deployment or secret output was used.

The driver verified the sponsorship gate, raw JSON-RPC `extXdr` ownership reads during opening/recovery, 0-XLM sponsored account/trustline creation, unsubmitted recovery storage, `txTooEarly`, timed recovery, same-key/name reopening, trustline-only repair, alternate-fee-payer inner settlement and terminal `sequence_consumed` evidence. Public hashes and checks are in [testnet.json](./testnet.json); exact stdout is also in `checks.txt`. The consumed-sequence live probe uses a recovery envelope invalidated by a device sequence bump, not a funded USDC payment.

## Findings and limits left untouched

No assigned code finding was intentionally skipped. The prior ownership, claim-window, opening-redraft, confirming-read, sponsorship, checksum and bounded-queue fixes remain in place. This round does not claim another independent Fable approval.

- Live USDC payments (including memo crediting) and recovery with a nonzero USDC balance remain unverified: no Circle testnet USDC was obtained. Their payment envelope, persistence, settlement and balance-guard behavior is covered locally. No substitute asset was presented as Circle USDC.
- An absent sender or history gap can still leave a signed transfer undecided and its sender slot occupied; guessing `Failed` would contradict the money-safety rule. A consumed sequence alone is insufficient evidence.
- Native XLM deposited after the final recovery balance check may still merge to the sponsor. An opening abandoned before recovery signing still locks reserves. These accepted limitations were not changed.
- Authentication/rate limiting, device UI and key storage, passkey/PRF backup, phone/OTP/escrow, mainnet, Worker CPU measurements and deployment remain deferred.

## Decisions I made

- Require a memo on external sends; reject memos on Orchid sends. Limit support to nonempty valid UTF-8 text and canonical decimal uint64 IDs; preserve leading U+FEFF, reject lone surrogates and leading-zero IDs rather than silently changing signed intent.
- Treat signed failed receipts as eligible for latest alongside authorized and settled receipts; keep the existing priority for an unfinished authorization.
- Use the official inner-hash index plus complete history through the observed account ledger to prove consumed-sequence rejection. Preserve undecided outcomes when that proof is unavailable.
