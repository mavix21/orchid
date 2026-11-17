# Orchid

A self-custodial “Yape crypto” wallet on Stellar.

## Problem

Crypto payments require users to manage addresses, networks and exchange deposit memos.

## Solution

Make these payment flows accessible from a mobile browser. The wallet server for Stellar testnet exists: sponsored account opening with permanent usernames, USDC transfers between usernames and to external addresses, and a scheduled sweep that settles transfers and recovers abandoned reserves. The web app creates a wallet from a secret phrase kept on the device and shows its username and USDC balance; the activity list and the send flow still use local mock data. Passkey backup and secret phrase export are not built yet.

## Key features

- Usernames and USDC transfers on Stellar testnet — account creation and balance are wired to the server; activity and sending use mock data.
- Exchange withdrawals with memo — server accepts text and ID memos; the known-exchange registry is empty.
- Self-custody — the server never holds user keys; the device stores an encrypted SEP-5 secret phrase. Passkey backup and phrase export are not built.

## Tech stack

Bun, React, TanStack Start, Vite, TypeScript, Tailwind CSS, shadcn, Base UI.

Cloudflare Workers/Hyperdrive: Wrangler, Vite plugin. Drizzle ORM, Effect and @effect/sql-pg. Oxlint, Oxfmt, Turbo, Effect language service.

## Getting started

Install Bun and Docker Desktop. Port 55432 must be free.

```sh
bun install
docker run -d --name orchid-postgres \
  -e POSTGRES_USER=orchid -e POSTGRES_PASSWORD=orchid-local -e POSTGRES_DB=orchid \
  -p 127.0.0.1:55432:5432 \
  -v orchid-postgres-data:/var/lib/postgresql/data postgres:17
bun run db:migrate:local
bun run dev
```

Open http://localhost:3000.

Creating an account needs two funded testnet accounts: the reserve sponsor and the fee payer. Put their secret keys in the gitignored `apps/web/.dev.vars`:

```sh
RESERVE_SPONSOR_SECRET=S...
FEE_PAYER_SECRET=S...
```

Fund each public key with Friendbot (`https://friendbot.stellar.org/?addr=G...`). `STELLAR_RPC_URL` is already set in `apps/web/wrangler.jsonc`. Testnet resets wipe both accounts; fund them again afterwards.

`bun run --cwd apps/web test:e2e` builds the app, serves it with `vite preview` and creates a real testnet wallet in Chromium (`bunx playwright install chromium` once). It needs the database above and `apps/web/.dev.vars`. Restart an existing database with `docker start orchid-postgres`.

Wrangler config supplies `nodejs_compat` and the local Docker connection string. `bun run dev` uses Docker even when Neon credentials exist in the root `.env.local`. Override the local connection string if needed:

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='postgres://orchid:orchid-local@127.0.0.1:55432/orchid'
bun run dev
```

Local Hyperdrive connects directly to Postgres without production pooling/caching. The configured Hyperdrive ID is used for the deployed Worker.

To explicitly develop against Neon, `bunx neon checkout dev` selects the database branch and pulls its credentials into the gitignored root `.env.local`. `bun run db:migrate` applies wallet migrations through `DATABASE_URL_UNPOOLED`. `bun run --cwd apps/web dev:neon` uses that URL for its local Hyperdrive connection; an explicit `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` takes precedence. Cron triggers are temporarily disabled.

`packages/db` exports `makeDatabase` and `databaseLayer`; the web server builds the layer from `env.HYPERDRIVE` inside each request. Wallet tables and their Drizzle migrations live in `packages/wallet`; see the [wallet README](packages/wallet/README.md) for its behaviour, tests and the Hyperdrive caching prerequisite for deployment. The design rationale is in [docs/architecture/wallet-testnet](docs/architecture/wallet-testnet/rationale.md).

Design tokens (Figma Light/Dark variables as shadcn CSS variables) live in `packages/ui/src/styles/tokens.css`; mock data for the screens lives in `apps/web/src/fixtures`.

Checks: `bun run typecheck`, `bun run lint`, `bun run fmt:check`, `bun run build`. Format: `bun run fmt`. Production preview: `bun run --cwd apps/web preview`.

## Team

Marcelo Vizcarra — https://mavix.dev

## License

To be determined. No license selected.
