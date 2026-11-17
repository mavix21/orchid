# Sketch: flows and invariants

Part of the [sketch index](sketch.md). Pseudocode for create, send, server submit and overview, and where each invariant is enforced.

## 5. Flows (pseudocode)

**create(username)**

1. Parse the username, or fail with `UsernameInvalid`. If the keystore already has an active profile, fail with `WalletExists`.
2. Reuse the keystore's _pending_ key or generate `Keypair.random()`. Persist it **before** any network call, and call `navigator.storage.persist()`. A crash later therefore never orphans a reserved username behind a lost key.
3. `BeginEnrollment` → `EnrollmentOffer`. The server reserves the username for this address. Re-reserving from the same address is idempotent and moves an unactivated reservation. The server then builds the sandwich and signs it as sponsor.
4. `checkEnrollment(offer, me)`, then sign → `CompleteEnrollment`. The server checks the envelope again, submits it, and waits for the outcome.
   - If the account already exists with a sponsored USDC trustline, the server treats that as success: the crash happened after an earlier submit.
   - `EnrollmentStale` (the sponsor's sequence moved) means repeat from step 3, at most 3 times.
5. Mark the keystore profile active and return it.

**send(draft)** (the no-double-send core)

1. If the outbox holds an entry, deliver it first. If it is still unresolved, fail with `TransferInFlight(entry)`. **At most one unresolved envelope per account**, so two envelopes can never both apply.
2. If the draft's quote is fresher than `freshQuoteMarginSeconds`, measured against `serverTime` plus elapsed device time, use it. Otherwise send `QuoteTransfer` again. If offline here, fail with `WalletOffline`; nothing has been signed.
3. `sequence = max(quote.sequence, outbox.lastSigned) + 1`. Build, sign with `maxTime = quote.validUntil`.
4. `outbox.put(entry)`. **This is the commit point.** If the write fails, fail with `DeviceStorageFailed`; nothing was sent.
5. `SubmitTransfer`, retried with a bounded backoff.
   - On a receipt, `outbox.settle(id)` and return `receipt.transfer`.
   - On a transport failure, return the transfer with status `"sending"`. The next `overview` or `send` redelivers the same bytes.

**Server: SubmitTransfer(envelope)**

1. `id = hash(inner)`. If a row with this id exists, go to step 5. This is idempotency by content, not by a client token.
2. `readTransfer`, which checks policy (`TransferRejected` means the receipt is `not_sent`, and nothing is stored). Both parties must be active in `Directory`.
3. If `now > validUntil`, ask `Chain.outcome`. If it is not applied, the receipt is `not_sent` and nothing is submitted.
4. Insert the row with `pending` and `envelope = Sponsor.feeBump(inner)` (`onConflictDoNothing`, then re-read).
5. If the row is `pending`, `Chain.submit(row.envelope)`, the same bytes every time. Then poll `Chain.outcome` a bounded number of times, about 2 ledgers. Update the row with `WHERE status = 'pending'`, so concurrent reconcilers converge.
6. Return a `Receipt` with the row as a `Transfer`.

**overview**

1. Deliver the outbox (best effort).
2. `ReadOverview(address)`. The server reads `Chain.balance` and `Transfers.activity`, which reconciles the pending rows it returns.
3. Merge in the local `"sending"` entry. `available = balance − Σ outgoing sending | pending`.

## 6. Invariants and where they live

| Invariant                                 | Enforced by                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The key never leaves the device           | Only `device/keystore.ts` touches it. Wallet routes are `ssr: false`.                                 |
| What the user saw is what gets signed     | `TransferDraft` can only be built by `preview` (sealed quote). Usernames are permanent once active.   |
| At most one send per confirmation         | Sequence numbers, plus one unresolved envelope per account (`outbox`), plus a fixed `maxTime`         |
| Retrying never creates a second payment   | Every retry submits the same signed bytes. The server keys on the inner hash and stores one fee bump. |
| "not_sent" is a fact, not a guess         | Only `Chain.outcome` after a ledger closes past `validUntil`, or a terminal on-ledger failure         |
| One writer per state                      | `wallets` → Directory. `transfers` → Transfers. Outbox and keystore → their device modules.           |
| Orchid only pays fees for wallet payments | `readTransfer` policy before `Sponsor.feeBump`. `checkEnrollment` before the device signs.            |
| Amounts are never floats                  | `Usdc` is a branded bigint in ledger units. Parsing and formatting happen only in `values.ts`.        |
