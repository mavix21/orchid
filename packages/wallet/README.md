# Wallet server for Stellar testnet

The root entry exports schemas and device-facing types. `@workspace/wallet/server` exports only `Wallet` and `WalletSettings`. Every server module is named `*.server.ts`. The root build runs three negative production builds and one positive transport build before the normal application build.

`Wallet` implements replayable `overview`, `open`, `transfer` and `sweep`. Opening submits the sponsored account/trustline first, then stores a signed, bounded recovery transaction before activation. Two confirming missing account/trustline reads produce `NeedsReopening`; opening retains the username and device key. Account creation and trustline repair are distinct variants of the same sponsorship layout.

Transfers pin the resolved recipient and order. Authorization freezes the fee-bumped bytes before submission. A transaction-level sender lock plus a partial unique index serializes authorization. Only ledger evidence concludes a transfer. RPC history gaps retain an undecided result. Server checksum failures return `InvalidAddress` before claiming a username. External recipients require a nonempty text (at most 28 UTF-8 bytes) or numeric ID (uint64) memo; missing memos return `ExternalMemoRequired`. Orchid recipients reject memos with `MemoNotAllowed`. Drafts, signed transactions, stored orders and receipts preserve the reference. Phone recipients return `PhoneNotSupported`; phone storage and escrow are absent.

The application creates database and wallet layers per request, validates server-function inputs and encodes outputs. Its Worker entry also runs a minute cron. Configure Hyperdrive with query caching disabled before using a deployed environment; this work does not provision or deploy one.

## Local verification

Use the PostgreSQL version documented by the root README, on a separate port:

```sh
docker run -d --rm --name orchid-wallet-verification \
  -e POSTGRES_USER=orchid -e POSTGRES_PASSWORD=orchid-local \
  -e POSTGRES_DB=wallet_test -p 127.0.0.1:55433:5432 postgres:17.12
bun run --cwd packages/wallet test
```

Tests use only this fixed local database, apply the official Effect Postgres migrator twice to check replay, and truncate its wallet tables between cases. Do not point it at application data. Stop the disposable database with `docker stop orchid-wallet-verification`.

Generate migrations with the official Drizzle Kit release matching the installed ORM:

```sh
bun run --cwd packages/wallet db:generate
```

The generated SQL and snapshot are in `drizzle/`. No migration is applied to Neon by these scripts.

## Live testnet verification

The one-shot driver uses a different local database and fresh keys. Preparation refuses to replace an existing `.dev.vars` file. Keys are saved only in `packages/wallet/.dev.vars` with mode `0600`, never printed. Build-cache outputs exclude `.dev.vars`. The driver verifies the RPC testnet passphrase before funding or submission.

```sh
docker exec orchid-wallet-verification createdb -U orchid wallet_live
bun run --cwd packages/wallet testnet:prepare
bun run --cwd packages/wallet testnet:verify
```

Friendbot funds separate reserve-sponsor and fee-payer accounts, plus an outsider used to verify the sponsorship refusal. Wallet users are created with 0 XLM. The driver checks raw `extXdr` sponsorship identities, alternate fee-payer inclusion via the inner hash, and rejection of an absent transaction whose sequence another transaction consumed. The verification driver uses a short recovery time through the internal builder and store; the public request path retains the one-day testnet delay. Public evidence is in `verification/testnet.json`. Circle testnet USDC was unavailable for the live payment check; payment signing, fee bumping, reconciliation and the nonzero-balance guard are covered by local tests.

The built Worker was also tested locally: fetch returned HTTP 200, and Wrangler's Local Explorer scheduled API returned `{"outcome":"ok","noRetry":false}`. The local database override was explicit. In this Wrangler version, the legacy `/__scheduled` URL returned 404; the advertised Local Explorer API successfully invoked the exported scheduled handler.

## Deferred work and limits

Device key storage and the UI replay loop, passkeys/PRF, `protect`/`recover`, enrollment envelopes, phone tables, OTP, escrow, Turnstile, mainnet and deployment are deferred. `WalletClient` and `DeviceSigner` are types only, with no working-looking implementations.

An opening abandoned before recovery signing keeps its reserve locked. Recovery covers only an account whose sequence has not advanced. The sweep skips observed nonzero USDC and native XLM balances. USDC deposits racing recovery are protected atomically by trustline removal; an XLM deposit racing the final check can still be merged to the sponsor by the pre-signed account merge. Mainnet recovery policy needs review before adoption.

Known reset handling uses the 2026-12-16 epoch boundary. Old unresolved transfers are preserved instead of being assigned fabricated failures; a new epoch permits new intents. An RPC outage longer than retained history or an advanced sequence with no located result can require operator reconciliation. Worker CPU limits and PRF support on real devices remain unmeasured.

## Review hardening

Reopened usernames are permanently bound to their original address. Only never-bound unsigned first claims expire, ten minutes after their last claim/draft activity. The upgrade binds all existing rows conservatively; it cannot reconstruct old activation history.

Recovery signing and submission require matching reserve-sponsor identities on both the account and trustline. The RPC wire decoder retains `extXdr` sponsorship metadata omitted by the installed SDK parser. Transfers look up both fee-bump and inner hashes. Expiry additionally requires a fresh sender sequence below the signed sequence; a consumed sequence concludes rejected only when retained inner-hash absence evidence covers its consumption. Missing history or an absent sender remains undecided. Unsigned drafts refresh their sequence before authorization and after reconciling a busy sender. Overview ignores unsigned drafts and retains `NeedsReopening` throughout repair. Openings alone may redraft after their ledger time bound without retained transaction history.

Each scheduled run selects up to four transfers and four currently eligible recovery wallets. Conditional queue writes bypass Hyperdrive read caching and rotate least-recently checked records. Two independent negative reads protect against demotion from one transient missing response.
