# Orchid

A self-custodial “Yape crypto” wallet on Stellar.

## Problem

Crypto payments require users to manage addresses, networks and exchange deposit memos.

## Solution

Make these payment flows accessible from a mobile browser. The wallet server for Stellar testnet exists: sponsored account opening with permanent usernames, USDC transfers between usernames and to external addresses, and a scheduled sweep that settles transfers and recovers abandoned reserves. The UI is still a placeholder page, and device key storage and passkey backup are not built yet.

## Key features

- Usernames and USDC transfers on Stellar testnet — server implemented; UI not built.
- Exchange withdrawals with memo — server accepts text and ID memos; the known-exchange registry is empty.
- Self-custody — the server never holds user keys; device key storage and passkey backup are not built.

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
bun run dev
```

Open http://localhost:3000. Restart an existing database with `docker start orchid-postgres`.

Wrangler config supplies `nodejs_compat` and the local Hyperdrive connection string. Its all-zero binding ID is a local-only placeholder. Override the connection string if needed:

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='postgres://orchid:orchid-local@127.0.0.1:55432/orchid'
bun run dev
```

Local Hyperdrive connects directly to Postgres without production pooling/caching. No real Hyperdrive resource is configured, so deploys are blocked by the wallet's caching check until one is.

`packages/db` exports `makeDatabase` and `databaseLayer`; the web server builds the layer from `env.HYPERDRIVE` inside each request. Wallet tables and their Drizzle migrations live in `packages/wallet`; see the [wallet README](packages/wallet/README.md) for its behaviour, tests and the Hyperdrive caching prerequisite for deployment. The design rationale is in [docs/architecture/wallet-testnet](docs/architecture/wallet-testnet/rationale.md).

Checks: `bun run typecheck`, `bun run lint`, `bun run fmt:check`, `bun run build`. Format: `bun run fmt`. Production preview: `bun run --cwd apps/web preview`.

## Team

Marcelo Vizcarra — https://mavix.dev

## License

To be determined. No license selected.
