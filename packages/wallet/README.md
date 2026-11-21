# Wallet server for Stellar testnet

The root entry exports schemas and device-facing types. `@workspace/wallet/server` exports only `Wallet`, `WalletSettings` and `concealFailure`. Every server module is named `*.server.ts`. The root build runs three negative production builds and one positive transport build before the normal application build.

`Wallet` implements replayable `overview`, `open`, `transfer` and `sweep`. Opening submits the sponsored account/trustline first, then stores a signed, bounded recovery transaction before activation. Two confirming missing account/trustline reads produce `NeedsReopening`; opening retains the username and device key. Account creation and trustline repair are distinct variants of the same sponsorship layout.

Transfers pin the resolved recipient and order. Authorization freezes the fee-bumped bytes before submission. A transaction-level sender lock plus a partial unique index serializes authorization. Only ledger evidence concludes a transfer. RPC history gaps retain an undecided result. Server checksum failures return `InvalidAddress` before claiming a username. External recipients accept an optional nonempty text (at most 28 UTF-8 bytes) or numeric ID (uint64) memo. An address requires one when the server-side known-exchange registry lists it or, failing that, when its account publishes the [SEP-29](https://stellar.org/protocol/sep-29) data entry `config.memo_required` with the exact value `1`, read over RPC `getLedgerEntries`; a missing entry or any other value requires nothing, and an unreachable RPC fails the step. Drafts report `memoRequired`, and a missing memo returns `ExternalMemoRequired` with the address, exchange and evidence source: the registry entry's, or `Exchange` and the SEP-29 URL for a ledger requirement. The check runs on every unsigned step, so a new requirement blocks an unsigned draft but never an authorized transfer. The registry ships empty; the policy for adding an entry is in [`exchange-memos.server.ts`](./src/server/exchange-memos.server.ts). Orchid recipients reject memos with `MemoNotAllowed`. Drafts, signed transactions, stored orders and receipts preserve the reference. A payment of an issued asset above the destination trustline's incoming capacity (limit minus balance minus buying liabilities) returns `RecipientCannotReceive` with reason `no_capacity`. Open claimables to usernames are limited to `claimableQuota.username` (2) per sender. Phone recipients return `PhoneNotSupported`; phone storage and escrow are absent.

The application creates database and wallet layers per request, validates server-function inputs and encodes outputs. Server functions decode their input inside the same boundary as the wallet call, so a request that cannot complete, including a malformed one, answers one of two encoded failures and never its cause: `LedgerUnreachable` when the Stellar RPC does not answer within `WalletSettings.rpcTimeout` (defaulting to 10 seconds) or answers with a JSON-RPC error, and `ServiceFailed` for anything else (store failures, broken invariants, undecodable RPC replies, defects, layer construction). `concealFailure` logs the full cause on the server before answering, and the sweep logs each failed record's cause. On the device, a request or code chunk that gets no response is `Offline` when the browser reports no network and `ServerUnreachable` otherwise, and a reply that does not decode is `InvalidResponse`; `Offline`, `ServerUnreachable` and `LedgerUnreachable` are worth retrying, `ServiceFailed` and `InvalidResponse` are not something the user can fix. Its Worker entry implements the scheduled sweep, but cron triggers are temporarily disabled in Wrangler configuration.

## Design

### Usernames

Usernames live in an insert-only `usernames` table: one name per address, never recycled. Before signing, `open` only checks availability. The name is bound in the same transaction that stores the signed opening. A losing racer gets `UsernameTaken` before anything is submitted, and an address that already holds another name gets `AddressBound`. The insert's returned row (`INSERT … ON CONFLICT DO NOTHING RETURNING`) decides each binding; on a conflict, a plain read in the same transaction finds the holder. An account that already exists without a name is bound in the transaction that activates it. Name lookups are plain reads and depend on the caching prerequisite below. Names containing `orchid` and the English and Spanish reserved words in `server/usernames.server.ts` cannot be bound. A bound name resolves only while its wallet is `active`; a recovered wallet keeps its name and reopens under it.

### Envelopes

`readEnvelope` accepts only the two opening variants (account creation and trustline repair), a payment, and the recovery transaction; anything extra is refused. A payment draft lives 120 seconds, and an approval is accepted only while 20 seconds remain. The recovery transaction has the user as source, the next sequence, `minTime` one day after drafting and `maxTime` seven days later on testnet, then exactly a USDC `changeTrust` with limit 0 and an `accountMerge` to the reserve sponsor. These constants are in `stellar/network.ts`.

### Recovery and settlement

Recovery signing and submission require matching reserve-sponsor identities on both the account and trustline. The RPC wire decoder retains `extXdr` sponsorship metadata omitted by the installed SDK parser. Transfers look up both fee-bump and inner hashes. Expiry additionally requires a fresh sender sequence below the signed sequence; a consumed sequence concludes rejected only when retained inner-hash absence evidence covers its consumption. Missing history or an absent sender remains undecided. Unsigned drafts refresh their sequence before authorization and after reconciling a busy sender. Overview ignores unsigned drafts. A recovered wallet stays `recovered`, and `overview` returns `NeedsReopening`, until repair reactivates it. Openings alone may redraft after their ledger time bound without retained transaction history. Wallet transitions compare a row version so a stale request cannot overwrite newer state.

### Device

`makeWalletClient(port, store)` implements `create`, `overview` and `saved` on the device. `saved` reads only the device: the stored username and whether an opening was approved, so an interrupted creation can resume. Each wallet's signing key derives from a 12-word English BIP-39 secret phrase on the SEP-5 path `m/44'/148'/0'`, so the phrase imports into other Stellar wallets. Before the first `open`, the client stores the phrase, address and username and reads them back; every retry reuses the stored phrase. It approves an opening only while the draft is live and opens its own address, and stores that opening's reserve sponsor before approving. It approves a recovery only when it merges into the same sponsor. Any other draft returns `DraftRejected` unsigned. Consecutive `OpeningPending` steps are polled two seconds apart, for at most twelve steps.

`send(intent)` turns the user's `TransferIntent` into a `TransferOrder` from the wallet's address and stores it on the device before the first `transfer`. Sending the same intent again replays that order and its id until a `Settled` or `Failed` step comes back, so a reload never creates a second order. The client approves a payment draft only when its source is the wallet's address and its destination, asset, amount and memo equal the order, and a claimable draft only when the draft's recipient is an Orchid profile, source, destination, asset and amount match, the order has no memo and its reserve sponsor is the wallet's. A username recipient matches only the profile the draft resolved for that username. A draft is approved only while both its `expiresAt` and its envelope's `maxTime` are at least `approvalMargin` seconds away, and the `maxTime` is no more than `paymentLifetime` plus a 60-second clock allowance away; when too little time remains, the client requests a fresh draft once, then returns `DraftRejected`. Before releasing a signature the device stores the signed envelope's `maxTime`; until that time plus the allowance has passed, it signs no other draft for the order. A different intent replaces a signed order only after the server reports it `Settled` or `Failed`, or, once the signature can no longer apply, answers anything other than `Pending` (the server reports an authorized order only as `Pending`, `Settled` or `Failed`); otherwise `send` returns `ApprovalOutstanding`. Mismatched drafts return `DraftRejected` unsigned, and every other step returns unchanged. `Pending` steps are polled like `OpeningPending`. `review(intent)` stores the order the same way, requests its draft without approval and returns a `PaymentReview` of the facts decoded from the envelope (destination address, asset, amount, memo, and whether it is a claimable), plus the draft's `memoRequired` and the order's username; a draft that does not match the order returns `DraftRejected`. `confirm(review)` signs only for the stored order the review shows, and only a draft whose destination and kind still match the review. `resume(id)` never signs: it polls the stored order only after its approval, until the server answers anything other than `Pending` or the order is still `Pending` two minutes after its own expiry, in which case it returns that `Pending` and a later `resume(id)` checks the same order again; and returns `ApprovalOutstanding` when the server still holds only a draft and the signature has not expired. For any other id, an unapproved order, or an order the device already forgot after `Settled` or `Failed`, it answers the overview's latest receipt with that id, or `NoTransfer` when there is none. `confirm` continues into `resume` when its last answer is `Pending`. `makeWalletEffects` exposes the same operations as interruptible effects; `makeWalletClient` runs them as promises. `Holding` carries the account entry's sponsoring ID (absent decodes as none), and `overview` stores it on a device that lacks a reserve sponsor.

`browserKeyStore` keeps the phrase in IndexedDB, encrypted with a non-extractable AES-GCM key stored beside it. This keeps the phrase out of raw storage exports but not out of reach of script running on the Orchid origin.

`makeWalletClient(port, store, passkeys)` also implements `backUp` and `restore`. Before the first `open`, creation registers a discoverable passkey (`browserPasskeys`, user verification required, ES256 or RS256) and stores a backup, so a username is never claimed without one. The passkey's PRF output for the salt `SHA-256("orchid secret phrase backup v1")` derives an AES-GCM-256 key through HKDF-SHA-256 (empty salt, info `orchid-secret-phrase-backup`); the server receives only the ciphertext and its 12-byte IV. When `create()` returns no PRF result, the client asks once more with `get()`. A cancelled passkey prompt (`NotAllowedError` or `AbortError`) returns `PasskeyCancelled` and claims nothing. A browser without WebAuthn, one whose `getClientCapabilities` reports no PRF, or a passkey that returns no PRF output records the wallet as device-only, and creation continues. Any other WebAuthn failure returns `PasskeyFailed`, which also stops creation with a retry. A failed assertion returns `AssertionRefused`, which is distinct from `NoBackup` (no backup for that credential). `DeviceWallet.backup` records `stored` or `deviceOnly`, so a resumed creation does not enroll again; a wallet whose opening was already approved enrolls only through `backUp`. `restore` refuses when the device already holds a wallet, never generates a phrase, and stores the restored wallet only when the decrypted phrase derives the returned account address.

The server issues single-use enrollment and restore challenges that expire after five minutes; a challenge is consumed before its signature is checked. It verifies registrations and assertions with `@passwordless-id/webauthn`, which documents Cloudflare Workers support, against the origins in `WalletSettings.passkeyOrigins`; the relying party ID is the origin's hostname. Backups are insert-only rows keyed by credential ID, so an enrollment cannot change what another passkey restores. Restore returns the username bound to the address, or the name requested at enrollment if the opening never finished.

### Scheduled sweep

Each scheduled run selects up to four transfers and four currently eligible recovery wallets. Queue selection is a conditional write that rotates least-recently checked records. Two independent negative reads protect against demotion from one transient missing response.

### Limits

The device client covers creation, overview, resuming, backup, restore, sending and reviewing payments only; secret phrase export, `protect`/`recover`, enrollment envelopes, phone tables, OTP, escrow, Turnstile, mainnet and deployment are not implemented. The recovery guard that skips a nonzero balance is not verified on testnet.

A restored wallet learns its reserve sponsor only from its first `Holding` overview. If it was restored after its opening was approved but before the recovery transaction was signed, the device rejects that recovery draft as `DraftRejected`.

An opening abandoned before recovery signing keeps its reserve locked: the server cannot produce the missing signature. Recovery covers only an account whose sequence has not advanced. The sweep skips observed nonzero USDC and native XLM balances. USDC deposits racing recovery are protected atomically by trustline removal; an XLM deposit racing the final check can still be merged to the sponsor by the pre-signed account merge. Mainnet recovery policy needs review before adoption.

Transfers and recovery work are scoped to a testnet epoch; the known reset on 2026-12-16 starts a new one. Old unresolved transfers are preserved instead of being assigned fabricated failures; a new epoch permits new intents. An RPC outage longer than retained history or an advanced sequence with no located result can require operator reconciliation.

## Deployment prerequisite: Hyperdrive query caching disabled

Wallet reads are plain `SELECT`s, and Hyperdrive caches eligible reads for 60 seconds by default. Before any deployed environment is used, the wallet's single Hyperdrive configuration must have query caching disabled, as [Cloudflare's query caching docs](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) describe:

```sh
bunx wrangler hyperdrive update <HYPERDRIVE_CONFIG_ID> --caching-disabled
```

`bun run --cwd apps/web deploy` runs `check:hyperdrive` (`tools/wallet/check-hyperdrive-caching.mjs`) first. The check covers the top-level Hyperdrive bindings in `apps/web/wrangler.jsonc` and those under each `env.<name>`, which it reads with `--env <name>`. For each binding it:

- refuses the placeholder id;
- reads the configuration with `wrangler hyperdrive get <id>`;
- stops the deploy unless the printed JSON has `caching.disabled: true`.

The id in the repository is still the placeholder, so deploys are blocked until the owner creates or updates the configuration and sets its id. These scripts never change Cloudflare resources.

Limits of the check:

- **Undocumented output.** Cloudflare does not document the output of `wrangler hyperdrive get`; the check relies on what wrangler 4.162.0 prints. If the output has no readable boolean `caching.disabled`, the check fails closed and says the output shape may have changed. In that case, verify manually that query caching is disabled for each configuration, then update the check before deploying.
- **Bypasses.** The check runs only through `bun run --cwd apps/web deploy`. A direct `wrangler deploy` skips it. Re-enabling caching on the configuration after a deploy is not detected until the next checked deploy.

## Local verification

Use the PostgreSQL version documented by the root README, on a separate port:

```sh
docker run -d --rm --name orchid-wallet-verification \
  -e POSTGRES_USER=orchid -e POSTGRES_PASSWORD=orchid-local \
  -e POSTGRES_DB=wallet_test -p 127.0.0.1:55433:5432 postgres:17.12
bun run --cwd packages/wallet test
```

Tests run with `@effect/vitest`. Database suites run serially with scoped shared layers and the live clock because wallet code and SQL use wall time. They use only this fixed local database, apply the official Effect Postgres migrator twice to check replay, and truncate its wallet tables between cases. Do not point it at application data. Stop the disposable database with `docker stop orchid-wallet-verification`.

Generate migrations with the official Drizzle Kit release matching the installed ORM:

```sh
bun run --cwd packages/wallet db:generate
```

The generated SQL and snapshot are in `drizzle/`. From the repository root, `bun run db:migrate` applies these migrations using `DATABASE_URL_UNPOOLED` from the gitignored `.env.local` pulled by Neon. Check the selected Neon branch before migrating.

## Live testnet verification

Both scripts keep no state between runs: no `.dev.vars` file, no fixed keys and no setup step. Each run generates fresh keys for the reserve sponsor, fee payer and every test account, funds the sponsor, fee payer and exchange through Friendbot (wallet users are created by sponsorship with 0 XLM), and recreates the `wallet_live` database (dropped, created and migrated) on the verification container above, which must be running; run one script at a time, because a new run drops the previous run's database. The driver verifies the RPC testnet passphrase before submitting anything. Both print their public evidence (addresses, transaction hashes and the checks performed) as JSON to stdout; put it in the pull request, not in a file.

`testnet:device` runs the device client against the real `Wallet` and live testnet. It creates a wallet with a fresh secret phrase and a software passkey, checks the opening, sponsorship, signed recovery and overview, opens a second username, funds the first wallet with 1 USDC (Friendbot plus a testnet path payment from XLM, the same helper the end-to-end tests use in [`testnet-funding.ts`](./scripts/testnet-funding.ts)), pays 0.5 USDC between the two usernames through `send`, and restores the wallet on a second in-memory device.

```sh
bun run --cwd packages/wallet testnet:device
```

`testnet:verify` is the one-shot driver. It funds a test exchange account with Friendbot and sets its `config.memo_required` data entry to `1`; an outsider account verifies the sponsorship refusal. Wallet users are created with 0 XLM, under usernames with a random per-run suffix. It checks raw `extXdr` sponsorship identities, alternate fee-payer inclusion via the inner hash, rejection of an absent transaction whose sequence another transaction consumed, that a second key cannot bind a username the first key already bound, and that payments to the test exchange return `ExternalMemoRequired` without a memo, settle with one, and settle to a muxed destination without one after the reserve sponsor sends the sender 5 XLM. It uses a short recovery time through the internal builder and store; the public request path keeps the one-day testnet delay.

```sh
bun run --cwd packages/wallet testnet:verify
```
