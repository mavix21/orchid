# Wallet server for Stellar testnet

The root entry exports schemas and device-facing types. `@workspace/wallet/server` exports only `Wallet` and `WalletSettings`. Every server module is named `*.server.ts`. The root build runs three negative production builds and one positive transport build before the normal application build.

`Wallet` implements replayable `overview`, `open`, `transfer` and `sweep`. Opening submits the sponsored account/trustline first, then stores a signed, bounded recovery transaction before activation. Two confirming missing account/trustline reads produce `NeedsReopening`; opening retains the username and device key. Account creation and trustline repair are distinct variants of the same sponsorship layout.

Transfers pin the resolved recipient and order. Authorization freezes the fee-bumped bytes before submission. A transaction-level sender lock plus a partial unique index serializes authorization. Only ledger evidence concludes a transfer. RPC history gaps retain an undecided result. Server checksum failures return `InvalidAddress` before claiming a username. External recipients accept an optional nonempty text (at most 28 UTF-8 bytes) or numeric ID (uint64) memo. Only addresses in the server-side known-exchange registry require one: drafts report `memoRequired`, and a missing memo returns `ExternalMemoRequired` with the address, exchange and evidence source. The check runs on every unsigned step, so a new entry blocks an unsigned draft but never an authorized transfer. The registry ships empty; the policy for adding an entry is in [`exchange-memos.server.ts`](./src/server/exchange-memos.server.ts). Orchid recipients reject memos with `MemoNotAllowed`. Drafts, signed transactions, stored orders and receipts preserve the reference. Phone recipients return `PhoneNotSupported`; phone storage and escrow are absent.

The application creates database and wallet layers per request, validates server-function inputs and encodes outputs. Its Worker entry implements the scheduled sweep, but cron triggers are temporarily disabled in Wrangler configuration.

## Design

### Usernames

Usernames live in an insert-only `usernames` table: one name per address, never recycled. Before signing, `open` only checks availability. The name is bound in the same transaction that stores the signed opening. A losing racer gets `UsernameTaken` before anything is submitted, and an address that already holds another name gets `AddressBound`. The insert's returned row (`INSERT … ON CONFLICT DO NOTHING RETURNING`) decides each binding; on a conflict, a plain read in the same transaction finds the holder. An account that already exists without a name is bound in the transaction that activates it. Name lookups are plain reads and depend on the caching prerequisite below. Names containing `orchid` and the English and Spanish reserved words in `server/usernames.server.ts` cannot be bound. A bound name resolves only while its wallet is `active`; a recovered wallet keeps its name and reopens under it.

### Envelopes

`readEnvelope` accepts only the two opening variants (account creation and trustline repair), a payment, and the recovery transaction; anything extra is refused. A payment draft lives 120 seconds, and an approval is accepted only while 20 seconds remain. The recovery transaction has the user as source, the next sequence, `minTime` one day after drafting and `maxTime` seven days later on testnet, then exactly a USDC `changeTrust` with limit 0 and an `accountMerge` to the reserve sponsor. These constants are in `stellar/network.ts`.

### Recovery and settlement

Recovery signing and submission require matching reserve-sponsor identities on both the account and trustline. The RPC wire decoder retains `extXdr` sponsorship metadata omitted by the installed SDK parser. Transfers look up both fee-bump and inner hashes. Expiry additionally requires a fresh sender sequence below the signed sequence; a consumed sequence concludes rejected only when retained inner-hash absence evidence covers its consumption. Missing history or an absent sender remains undecided. Unsigned drafts refresh their sequence before authorization and after reconciling a busy sender. Overview ignores unsigned drafts. A recovered wallet stays `recovered`, and `overview` returns `NeedsReopening`, until repair reactivates it. Openings alone may redraft after their ledger time bound without retained transaction history. Wallet transitions compare a row version so a stale request cannot overwrite newer state.

### Device

`makeWalletClient(port, store)` implements `create`, `overview` and `saved` on the device. `saved` reads only the device: the stored username and whether an opening was approved, so an interrupted creation can resume. Each wallet's signing key derives from a 12-word English BIP-39 secret phrase on the SEP-5 path `m/44'/148'/0'`, so the phrase imports into other Stellar wallets. Before the first `open`, the client stores the phrase, address and username and reads them back; every retry reuses the stored phrase. It approves an opening only while the draft is live and opens its own address, and stores that opening's reserve sponsor before approving. It approves a recovery only when it merges into the same sponsor. Any other draft returns `DraftRejected` unsigned. Consecutive `OpeningPending` steps are polled two seconds apart, for at most twelve steps.

`browserKeyStore` keeps the phrase in IndexedDB, encrypted with a non-extractable AES-GCM key stored beside it. This keeps the phrase out of raw storage exports but not out of reach of script running on the Orchid origin.

### Scheduled sweep

Each scheduled run selects up to four transfers and four currently eligible recovery wallets. Queue selection is a conditional write that rotates least-recently checked records. Two independent negative reads protect against demotion from one transient missing response.

### Limits

The device client covers creation, overview and resuming only; sending from the device, secret phrase export, passkeys/PRF, `protect`/`recover`, enrollment envelopes, phone tables, OTP, escrow, Turnstile, mainnet and deployment are not implemented. A live USDC payment and the recovery guard that skips a nonzero balance are not verified on testnet.

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

## Live device verification

`testnet:device` runs the device client against the real `Wallet`, live testnet and the `wallet_live` database, using the reserve sponsor and fee payer from `apps/web/.dev.vars`. Each run creates a new wallet with a fresh secret phrase and checks the opening, sponsorship, signed recovery and overview. It prints public evidence as JSON to stdout; put it in the pull request, not in a file.

```sh
docker exec orchid-wallet-verification createdb -U orchid wallet_live
bun run --cwd packages/wallet testnet:device
```

## Live testnet verification

The one-shot driver uses a different local database and fresh keys. Preparation refuses to replace an existing `.dev.vars` file. Keys are saved only in `packages/wallet/.dev.vars` with mode `0600`, never printed. Build-cache outputs exclude `.dev.vars`. The driver verifies the RPC testnet passphrase before funding or submission.

```sh
docker exec orchid-wallet-verification createdb -U orchid wallet_live
bun run --cwd packages/wallet testnet:prepare
bun run --cwd packages/wallet testnet:verify
```

Friendbot funds separate reserve-sponsor and fee-payer accounts, plus an outsider used to verify the sponsorship refusal. Wallet users are created with 0 XLM. The driver checks raw `extXdr` sponsorship identities, alternate fee-payer inclusion via the inner hash, rejection of an absent transaction whose sequence another transaction consumed, and that a second key cannot bind a username the first key already bound. It uses a short recovery time through the internal builder and store; the public request path keeps the one-day testnet delay. It prints the public evidence (account addresses, transaction hashes and the checks performed) as JSON to stdout; put it in the pull request, not in a file.
