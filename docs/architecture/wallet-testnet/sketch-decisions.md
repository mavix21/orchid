# Sketch: approved decisions

Part of the [core wallet flow sketch](sketch.md). Owner decisions and review fixes. They take precedence over the illustrative service signatures and flow pseudocode in the other parts.

## Approved implementation scope (2026-11-16)

These owner-approved decisions take precedence over the illustrative service signatures in [the contract](sketch-contract.md) and [the server entry](sketch-server.md), and over the flow pseudocode in [the flows](sketch-flows.md).

- This step implements `overview`, `open`, `transfer` and the scheduled sweep. Passkey backup, `protect`, `recover` and the enrollment envelope layout belong to the later backup step; do not add working-looking stubs. `readEnvelope` accepts only opening, payment and abandoned-account recovery layouts in this step.
- Opening uses two signing stages behind one user action. `OpeningDraft` carries the opening request; submit it first. Once the account exists, build a recovery request from its confirmed sequence and return `RecoveryDraft`. Both stages use `Approval` (one signature, no envelope) and the same replayable `open`. The recovery transaction has the user as source, sequence current + 1, `minTime` and `maxTime`, then exactly USDC `changeTrust` limit 0 and `accountMerge` to the reserve sponsor. Validate its layout and signature and store it unsubmitted before returning `Opened`. The sweep checks balance and sequence before recovery submission and marks a merged wallet `recovered`.
- An account that exists but lacks signed recovery stays `opening`. A later app session resumes `open` and requests that signature. If the device never returns, its reserve remains locked; this limitation is accepted. No background service can supply the missing signature.
- If an active wallet loses its account or USDC trustline, `overview` returns `NeedsReopening` and marks the row `recovered`; replayable `open` repairs the account and/or trustline under the same username and device key, then repeats recovery signing.
- A resolved transfer recipient is either an Orchid `Profile` (username and address, no memo) or an external address without a username (text/id memo optional unless the address is a known memo-requiring exchange; see the 2026-11-16 memo decision below). Drafts, stored transfers and receipts retain that resolved recipient. `transfers.recipient` is nullable for external addresses; their destination address must still be stored. `Phone` resolves to a typed not-supported-yet outcome; no phone implementation is added.

## Username binding decision (owner, 2026-11-17)

This supersedes the earlier expiring unsigned claims, the `claimed`/`reopening` states and the `ownershipBound` flag.

- Names live in their own table, `usernames(username primary key, address unique, boundAt)`. A row is inserted once and never updated or deleted, so a name is never recycled and an address has at most one name. Renames are out of scope.
- A name is either available or bound. It is bound in the same transaction that stores the signed opening, because that signature already proves key control. The insert itself decides the race (`INSERT … ON CONFLICT DO NOTHING RETURNING`). Name reads are never plain `SELECT`s, which Hyperdrive may cache; they are no-op `UPDATE wallets … FROM usernames … RETURNING` writes, which Hyperdrive does not cache. If the name is already bound to another address, `open` returns `UsernameTaken` and stores and submits nothing, so the loser of a race costs Orchid nothing. If the address already holds another name, `open` returns `AddressBound` with that profile rather than signing under a name the device did not ask for.
- Before signing, `open` makes only a soft availability check. Drafts reserve nothing, and a key may change its requested name until it signs. An account that already exists without a name (for example, after a database restore) is bound in the transaction that activates it.
- No name containing `orchid` can be bound, and neither can a short constant list of English and Spanish reserved words (`support`, `admin`, `security`, `wallet`, `official`, `soporte`, `ayuda`, `seguridad`, `oficial`, `equipo`, `billetera`, `administrador` and similar). This blocks new bindings only.
- Wallet status is `opening`, `active` or `recovered`. A recovered wallet stays `recovered` while it is repaired, so `overview` returns `NeedsReopening` until activation. Marking a wallet recovered drops its spent opening and recovery data; activation records the current testnet epoch. The two confirming reads before demotion remain.
- A name resolves to a payable recipient only while its wallet is `active`. Bound forever does not mean always payable. Reopening after reserve recovery or a testnet reset reuses the bound name, and only the original address can use it.
- The migration binds every existing name except unsigned, never-bound first claims, which the old rules could still hand to another key. `claimed` rows become `opening`, `reopening` rows become `recovered` with their in-progress attempt kept, and already `recovered` rows drop stale opening and recovery data.

## External memo decision (owner, 2026-11-16)

This supersedes the earlier rule that every external send requires a memo.

- A memo is required only for an address listed in the server-side known-exchange registry (`server/exchange-memos.server.ts`). Every other external address accepts an optional `text` or `id` memo, validated when present. Orchid recipients still refuse memos (`MemoNotAllowed`).
- Each registry entry records the network, the exact checksum-valid address, the exchange name and a public HTTPS source that states that this address needs a memo on that network. Brand-level deposit instructions without a published address are not evidence. The registry ships empty: official Binance and Lemon pages describe memo requirements but publish no verifiable address list, and no addresses are invented. Evidence rules are in `packages/wallet/verification/exchange-memos.md`.
- `TransferDraft` carries `memoRequired` so the device can say a memo is needed. A listed destination without a memo returns `ExternalMemoRequired` with the address, exchange and source, before any draft is stored. An unlisted address makes no claim that the registry is complete: `memoRequired: false` means "not known to require one", not "safe without one".
- The check runs on every unsigned step. A registry entry added after a draft blocks its signature; an already authorized transfer is never blocked or altered by a later entry.

## Fable review fixes and decisions

- Reopening keeps its original username and address; see the username binding decision above.
- A sealed opening may be replaced once the ledger clock passes its maximum time and a fresh account observation still requires opening/repair. Transfer settlement queries outer and inner hashes. `Expired` still requires a current sender sequence below the transaction sequence and complete inclusion-window history. A consumed sequence concludes rejected only when an inner-hash absence read has retained history from `minTime` through the observed account ledger; otherwise it stays undecided. Included failures that never executed the inner operations alone do not prove rejection.
- Two independent negative account/trustline observations are required before demotion. A wall-clock epoch boundary alone does not demote a positively observed wallet.
- `InvalidAddress` is a server checksum refusal before any username claim. `NotSponsored` refuses recovery consent unless the account and USDC trustline both name the configured reserve sponsor. Missing sponsorship metadata fails closed; sponsored counts alone are insufficient.
- Sweeps take at most four transfers and four wallets per scheduled run, rotate oldest-checked work, and read queues using conditional `UPDATE ... RETURNING`. Recovery wallets must be active, in the current epoch, and inside their recovery window. Expired windows leave background work; later overview still detects a missing account.
- Payments have exactly one USDC operation. The order optionally carries a Stellar `text` (nonempty UTF-8, at most 28 bytes) or `id` (canonical decimal uint64) memo; external payments accept one, Orchid profiles refuse one (`MemoNotAllowed`), and only known memo-requiring exchange addresses refuse a missing one (`ExternalMemoRequired`; see the memo decision below). The strict reader, sealing, stored order and receipts preserve it; hash/return memos remain unsupported. This replaces the earlier blanket external-send refusal.
- Unsigned drafts refresh whenever the current account sequence + 1 differs from the draft sequence, including before authorization and after a completed `SlotTaken` holder. Compare the previous draft when storing a replacement; signed bytes remain immutable. A race after the final read is resolved by settlement evidence.
- `overview` returns `NeedsReopening` while a recovered wallet is repaired. Its latest receipt includes only authorized or concluded transfers; unsigned drafts cannot hide it.
- The official RPC implementation indexes both fee-bump hashes ([inspected source](https://github.com/stellar/stellar-rpc/blob/cacf18510507762fe3ae827f237658d4c61b6456/cmd/stellar-rpc/internal/rpcv1/sqlitedb/transaction.go#L85)). Consumed-sequence rejection relies on that index and its reported history range; history gaps remain undecided.
- Sponsor identity is read from the official RPC `extXdr` ledger extensions, which SDK 17.4.0's parsed ledger response omits. The official wire format is decoded with Schema and the installed XDR classes, without patching SDK types.

## Implementation decisions for review

- Opening repair uses the same sponsorship layout without `createAccount` when the account survives but its trustline is missing. The strict reader accepts these two opening variants only.
- Testnet defaults: recovery one day after its draft is built, and a seven-day recovery submission window. These are in `stellar/network.ts`; production timing is not implemented.
- `NeedsReopening` carries the retained profile. Reopening never changes its username or device address. Wallet transitions compare a version to prevent stale requests from overwriting newer state.
- Authorization accepts the stored proposed record, compares its draft when writing, and acquires the sender lock before any row lock.
- Transfer locks and reads are scoped to network and testnet epoch; the known 2026-12-16 reset starts a new epoch. Old unresolved transfers remain unchanged rather than acquiring an invented final result. A new epoch permits new intents.
- RPC `NOT_FOUND` only proves expiry while history covers the whole transaction inclusion window. Otherwise keep `Undecided`; operator reconciliation may be needed after a long outage. A submit response never concludes a transfer.
- Recovery also skips accounts observed holding native XLM. An XLM deposit racing the final check remains an account-merge limitation; USDC removal is protected atomically on-chain.
- The router context holds the app port so all three server functions are included in normal builds before the device UI is implemented.
- The server-facing device seam is types only in this step. Key persistence, the UI replay loop and passkey backup follow later; no working-looking device stubs are shipped.
