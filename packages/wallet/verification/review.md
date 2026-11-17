# Fable review verification

## Plain reads round (Fable review, owner decision, 2026-11-17)

Fable judged the cache-safe round's no-op `UPDATE … RETURNING` reads (below) a workaround. Every name lookup wrote to and locked the holder's wallet row, so an unauthenticated soft check could cause writes on anyone's wallet. The owner approved the official path from [Cloudflare's query caching docs](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/), which the repo had already chosen in `rationale.md`, `ground.md` and the README: query caching disabled on the single existing Hyperdrive configuration (`wrangler hyperdrive update <id> --caching-disabled`).

- **Kept.** `INSERT … ON CONFLICT DO NOTHING RETURNING` still decides the name race. A conflict with no holder still fails. Transitions stay conditional `UPDATE … WHERE version = … RETURNING`, and queue selection stays a real rotating write.
- **Plain reads again.** The following are now plain `SELECT`s: name lookups, the soft check, `profile`, `byUsername` (one joined read requiring an `active` wallet), `Directory` and `Transfers` `find`, `Transfers.latestFrom`, the authorize holder check and its re-read. The seal/activate locks are `SELECT … FOR UPDATE` again.
- **Checked prerequisite.** `apps/web`'s `deploy` script now runs `check:hyperdrive` first (`tools/wallet/check-hyperdrive-caching.mjs`). For each Hyperdrive binding in `wrangler.jsonc`, the check:
  - refuses the placeholder id;
  - runs the official `wrangler hyperdrive get <id>`, which in installed wrangler 4.162.0 prints the configuration JSON, where `--caching-disabled` is stored as `caching.disabled`;
  - stops unless that field is `true`.

  Verified without Cloudflare access: the real config exits 1 on the placeholder id; a fake `wrangler` on `PATH` exits 0 for `disabled: true` and 1 for `false`. The owner runs the update; nothing here touches Cloudflare.

- **Verification at `46f98cd`.** Lint, fmt check, typecheck, build, package tests (50 pass, 0 fail, 635 assertions), `db:generate` (no schema changes) and live `testnet:verify` all exited 0. As intended, `check:hyperdrive` exited 1 on the placeholder id. Output is in [checks.txt](./checks.txt).
- **Correction.** The cache-safe round said the docs' alternative was "a second cache-disabled Hyperdrive binding". The docs offer two official options: disable caching on a configuration (`--caching-disabled`), which this repo already uses, or add a second cache-disabled configuration for fresh reads. That round's plain-`SELECT` concern now depends on the prerequisite, as the docs intend.

## Cache-safe binding round (superseded by the plain reads round)

Fable found that `bind` decided the name race from a plain `SELECT`, which a caching Hyperdrive could serve stale. The round introduced `INSERT … ON CONFLICT DO NOTHING RETURNING` as the race decision, which is kept. It also replaced name reads, `profile`, `byUsername` and row locks with no-op `UPDATE … RETURNING` writes, which have since been reverted. Reserved names were widened: anything containing `orchid` is refused, and Spanish words were added (soporte, ayuda, seguridad, oficial, equipo, billetera, cartera, monedero, administrador, administracion, sistema, moderador, operador, propietario, servicio, pagos, facturacion, verificar, verificado, cuenta, cuentas, contacto). A name bound before it was reserved still works for its own address. Tests added then still run:

- reserved and substring refusals;
- a pre-reserved name staying usable by its owner;
- the activation bind refusing a name bound after the soft check;
- a new user being payable by username straight after activation.

That round verified at `06c6a4d`: 50 tests passed, and live `testnet:verify` exited 0.

## File size round (2026-11-17)

This is a pure refactor so that every file this PR changes is within the 5,000-token limit (bytes / 4) of the pre-commit check proposed in PR #2. Files on that check's ignore list are exempt. The refactor is in `c9cba2b` (code and tests) and `b0b1137` (docs).

- `Wallet.server.ts` keeps transfer, overview and sweep. The `open` flow moved to `wallet-opening.server.ts`, and the confirming account reads and `live` moved to `wallet-reads.server.ts`. Both are Effects that yield their own services.
- `store.test.ts` was split into a shared `wallet-harness.ts` (fake chain, layers, helpers and `useDisposableDatabase()`) and seven files: opening, usernames, username-migration, transfers, transfer-drafts, transfer-memos and sweep. Every test is unchanged; the suite still has 47 tests and 612 assertions.
- `sketch.md` and `backup.md` are now indexes. Their sections moved unchanged into `sketch-*.md` and `backup-*.md`, keeping their section numbers. Cross-file "section N" mentions became links, and a script confirmed that all 74 relative links and anchors resolve.
- Lint, fmt check, typecheck, build, the package tests and `db:generate` (no schema changes) all exited 0 after the split. PR #2's script, run over all 75 files changed against `origin/main`, exited 0 with no output. Live testnet was not rerun for this refactor.

## Username binding round (owner decision, 2026-11-17)

Fable's advisor review replaced expiring unsigned claims with permanent binding at the signed opening. Implemented in `6ba0e4b` and `b8550de` (row lock). Verified at `b8550de`: lint, fmt check, typecheck, build, package tests (47 pass, 0 fail, 612 assertions), `db:generate` (no schema changes) and live `testnet:verify` all exited 0.

- **Table.** `usernames(username primary key, address unique, boundAt)` is insert-only: one name per address, never recycled. `wallets.username`, `claimedAt` and `ownershipBound`, the `claimed` and `reopening` states, `claimLifetime` and the claim-expiry takeover are gone, along with the two tests that only covered it.
- **Binding.** `open` makes a soft availability check before signing; drafts reserve nothing. `Directory.seal` binds the name and stores the signed opening in one transaction. A name already bound elsewhere returns `UsernameTaken` and nothing is stored or submitted. Both writes lock the wallet row before binding, so a stale write stores neither the name nor the attempt. Activation repeats the bind, normally as a no-op, so an account that existed before its row was named is still bound before it becomes active.
- **Bug fix.** A key that drafted `maria` and then asks for `maria2` now gets a draft for `maria2`, and `maria` stays free.
- **Decision: new `AddressBound` outcome.** An address that already holds a name and asks for a different one gets `AddressBound { profile }`. `UsernameTaken` would be false (the other name may be free), and silently using the bound name would have the device sign under a name it did not ask for. This adds one member to `OpenStep` and the device `CreateOutcome`.
- **Decision: `reopening` folds into `recovered`.** The old state existed so that the reopening claim could clear stale data exactly once. That reset now happens in `recover()`, which runs once per active-to-recovered transition, and activation records the current testnet epoch. A recovered row stays `recovered` while it is repaired, so `overview` still returns `NeedsReopening` throughout. No behavior was lost: the reopening and repair tests and the live reopening/repair still pass.
- **Reserved words.** `server/usernames.server.ts` is a plain constant set. It blocks new bindings only and lives on the server, not in the `Username` schema, so a name bound before it was reserved still decodes.
- **Resolution.** `byUsername` resolves only active wallets. A recovered wallet's name returns `UnknownRecipient` to senders and `UsernameTaken` to other keys, and is reusable only by its original address.
- **Reads.** (Superseded by the cache-safe binding round.) Name rows are immutable, so lookups used plain `SELECT`, which relied on Hyperdrive query caching being disabled as the README requires. Binding reads its result inside its transaction after `INSERT … ON CONFLICT DO NOTHING`, so a concurrent winner is seen after it commits.
- **Migrations.** All three come from `drizzle-kit generate`: add `usernames`, a `--custom` data step, then drop the old columns. Every existing name is bound except unsigned, never-bound first claims, which the old rules could still hand over. `claimed` becomes `opening`. `reopening` becomes `recovered` and keeps its in-progress attempt. Already `recovered` rows drop stale attempt and recovery data so they can reopen. A test applies the two earlier migrations to a scratch database, seeds one row per old state, applies the rest, checks names and statuses, and reopens the migrated recovered wallet end to end. `db:generate` afterwards reports no schema changes.
- **New tests.** The binding write refuses a taken name even when called directly, without the soft check; a stale binding write stores neither the attempt nor the name (this test fails without the row lock); abandoned-draft rename; a concurrent race (one bind, one `UsernameTaken`, one submission, then the loser opens under another name); reserved words; a recovered name that stays bound but is unpayable until reactivated, with `AddressBound` for a different name; binding an existing unnamed account at activation.
- **Live testnet.** The driver now drafts the same name from a second key, binds it with the first, and confirms that the second approval returns `UsernameTaken` and the second account does not exist. Fresh keys were generated into gitignored `.dev.vars`; the previous file was moved, unread, outside the repository. Results are in [testnet.json](./testnet.json) and [checks.txt](./checks.txt). One earlier live run in this round failed at the trustline-only repair assertion. The repair transaction was applied on chain, but the next `open` read the account before the RPC showed the restored trustline. That read stored a fresh unsigned opening draft, which cleared `attemptHash`, and the driver read `attemptHash` only after activation. The opening logic for this path did not change in this round. The driver now records each signed hash right after approval, and the rerun passed. Open item: after a settled opening, a lagging read can still offer the device one unneeded `OpeningDraft`.

## Memo registry round (owner decision, 2026-11-16)

A memo is now required only for addresses known to belong to exchanges that need one. Every other external send accepts an optional text/id memo, validated when present. Orchid-to-Orchid sends still refuse memos.

- `server/exchange-memos.server.ts` adds a typed, server-only `KnownExchangeMemo` registry: testnet network, checksum-valid address, exchange name, HTTPS source. It ships **empty**. Official Binance and Lemon pages describe memo requirements but publish no verifiable address list, so no address was added. [exchange-memos.md](./exchange-memos.md) defines what evidence an entry needs.
- `TransferDraft.memoRequired` is true only for a listed address. A listed destination without a memo returns `ExternalMemoRequired { address, exchange, source }` before any draft is stored. An unlisted address returns a draft with `memoRequired: false`; this does not claim the registry is complete.
- The refusal is checked on every unsigned step (new order, replayed draft, approval). A later entry blocks signing an existing unsigned draft. It cannot block or change an already authorized transfer.
- No database change: the memo already lives in the stored order, and the registry is code. `drizzle-kit generate` reports no schema changes.
- Tests cover: unlisted external sends without a memo that sign, settle and keep no memo, with `MEMO_NONE` on the inner transaction; a listed address refusing a missing memo with its evidence, leaving no row or submission; text/id memos on both listed and unlisted addresses; a registry entry added between draft and approval; Orchid recipients still refusing memos with `memoRequired: false`; and the schema rejecting a wrong network, bad checksum, non-HTTPS source and empty exchange name. Live testnet was not rerun; this change touches no opening, recovery or submission path. Live USDC payments remain unverified as before.
- `bun lint`, `bun run fmt:check`, `bun run typecheck`, `bun run build` and the package tests exited 0. The tests ran against the disposable PostgreSQL 17.12 container: 41 pass, 0 fail, 567 assertions. [checks.txt](./checks.txt) has the output.

## Re-review round

The four code findings in the owner's re-review were verified against `35331cc`/`dedc64a` and addressed in `7b8b673`. The latest-receipt finding needs one qualification: authorized rows already had priority; a newer unsigned draft could hide a concluded receipt.

- Stale proposals now compare their sequence to the account before returning a draft, immediately before authorization, and after reconciling a completed `SlotTaken` holder. Replacements compare the previous proposed envelope; they cannot replace a concurrent signed authorization. The old approval is never reused to authorize the replacement.
- A consumed sequence reaches rejected only when an inner-hash `NOT_FOUND` has retained history from the transaction's `minTime` through the observed account ledger. That proves this transaction absent while another transaction consumed its sequence, and releases the sender slot. Insufficient history or lagging ingestion remains undecided. `Expired` still requires the sender sequence below the transaction sequence and full time-window coverage.
- `reopening` returns `NeedsReopening` (now: a recovered wallet under repair; see the username binding round). Latest selects authorized, settled or failed rows; proposed rows cannot hide a receipt.
- External orders optionally carry the official SDK's text/id memo kinds: a nonempty text memo (1–28 UTF-8 bytes) or canonical decimal uint64 ID. This round required one on every external send; the memo-registry round below narrows that. Orchid profiles refuse memos. Boundary schemas reject unsupported/invalid memo values and malformed Unicode; the SDK builds the memo, and the strict reader, signature, order JSON and receipts retain it. No database migration is needed: official `drizzle-kit generate` reports no schema changes.

The official RPC reference does not explicitly promise fee-bump inner-hash aliasing. This round inspected the [official implementation](https://github.com/stellar/stellar-rpc/blob/cacf18510507762fe3ae827f237658d4c61b6456/cmd/stellar-rpc/internal/rpcv1/sqlitedb/transaction.go#L85), which indexes both hashes. The new absence proof relies on that index and the RPC's reported history range. A fresh live test also resolved an inner transaction submitted under a different fee payer while the original outer hash remained `NOT_FOUND`.

## Verification

All required commands exited 0. [checks.txt](./checks.txt) preserves their complete command output, including nonfatal Turbo cache permission warnings. Package tests use the documented disposable PostgreSQL 17.12 container and apply the official Effect Postgres migrator twice. The final suite has 38 passing tests, 0 failures and 529 assertions; three real negative Vite builds and a positive transport build also pass.

The fresh `testnet:verify` run finished at `2026-11-17T00:01:48.063Z`. Fresh keys were generated only into gitignored `.dev.vars`; the previous env file was renamed without reading it. Friendbot funded separate sponsor/fee-payer keys and an unsponsored outsider. No production database, deployment or secret output was used.

The driver verified the sponsorship gate, raw JSON-RPC `extXdr` ownership reads during opening/recovery, 0-XLM sponsored account/trustline creation, unsubmitted recovery storage, `txTooEarly`, timed recovery, same-key/name reopening, trustline-only repair, alternate-fee-payer inner settlement and terminal `sequence_consumed` evidence. Public hashes and checks are in [testnet.json](./testnet.json); exact stdout is also in `checks.txt`. The consumed-sequence live probe uses a recovery envelope invalidated by a device sequence bump, not a funded USDC payment.

## Findings and limits left untouched

No assigned code finding was intentionally skipped. The prior ownership and claim-window fixes were later replaced by permanent binding (see the username binding round). The opening-redraft, confirming-read, sponsorship, checksum and bounded-queue fixes remain in place. This round does not claim another independent Fable approval.

- Live USDC payments (including memo crediting) and recovery with a nonzero USDC balance remain unverified: no Circle testnet USDC was obtained. Their payment envelope, persistence, settlement and balance-guard behavior is covered locally. No substitute asset was presented as Circle USDC.
- An absent sender or history gap can still leave a signed transfer undecided and its sender slot occupied; guessing `Failed` would contradict the money-safety rule. A consumed sequence alone is insufficient evidence.
- Native XLM deposited after the final recovery balance check may still merge to the sponsor. An opening abandoned before recovery signing still locks reserves. These accepted limitations were not changed.
- Authentication/rate limiting, device UI and key storage, passkey/PRF backup, phone/OTP/escrow, mainnet, Worker CPU measurements and deployment remain deferred.

## Decisions I made

- Reject memos on Orchid sends. (Requiring a memo on every external send was superseded by the owner's memo-registry decision below.) Limit support to nonempty valid UTF-8 text and canonical decimal uint64 IDs; preserve leading U+FEFF, reject lone surrogates and leading-zero IDs rather than silently changing signed intent.
- Treat signed failed receipts as eligible for latest alongside authorized and settled receipts; keep the existing priority for an unfinished authorization.
- Use the official inner-hash index plus complete history through the observed account ledger to prove consumed-sequence rejection. Preserve undecided outcomes when that proof is unavailable.
