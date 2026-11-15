# Orchid

A self-custodial “Yape crypto” wallet on Stellar, planned as a mobile-first PWA.

## Problem

Crypto payments require users to manage addresses, networks and exchange deposit memos.

## Solution

Make these payment flows accessible from a mobile browser. Currently only the application and database foundation exists.

## Key features

- Payment links — planned.
- Lemon/exchange withdrawals with memo — planned.
- Agent-ready access via MCP — planned.
- Self-custody and PWA support — planned.

## Tech stack

Bun 1.4.4, React 19.3.1, TanStack Start 1.169.5, Vite 8.3.8, TypeScript 7.0.2, Tailwind CSS 4.3.5, shadcn 4.23.0, Base UI 1.9.0.

Cloudflare Workers/Hyperdrive: Wrangler 4.162.0, Vite plugin 1.69.1. Drizzle ORM 1.0.0-rc.5, Effect and @effect/sql-pg 4.1.4. Oxlint 1.93.0, Oxfmt 0.78.0, Turbo 2.11.11, Effect language service 0.69.0.

## Getting started

Install Bun 1.4.4 and Docker Desktop. Port 55432 must be free.

```sh
bun install
docker run -d --name orchid-postgres \
  -e POSTGRES_USER=orchid -e POSTGRES_PASSWORD=orchid-local -e POSTGRES_DB=orchid \
  -p 127.0.0.1:55432:5432 \
  -v orchid-postgres-data:/var/lib/postgresql/data postgres:17.12
bun run dev
```

Open http://localhost:3000. Restart an existing database with `docker start orchid-postgres`.

Wrangler config supplies `nodejs_compat` and the local Hyperdrive connection string. Its all-zero binding ID is a local-only placeholder. Override the connection string if needed:

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='postgres://orchid:orchid-local@127.0.0.1:55432/orchid'
bun run dev
```

Local Hyperdrive connects directly to Postgres without production pooling/caching. No real Hyperdrive resource is configured.

`packages/db` exports `makeDatabase` and `databaseLayer`. The web server adapter builds the layer from `env.HYPERDRIVE` inside a request. Provide it to the database Effect program. The schema is empty; no wallet tables or migrations exist yet.

Checks: `bun run typecheck`, `bun run lint`, `bun run fmt:check`, `bun run build`. Format: `bun run fmt`. Production preview: `bun run --cwd apps/web preview`.

## Team

Marcelo Vizcarra — https://mavix.dev

## License

To be determined. No license selected.
