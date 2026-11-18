# Orchid

**Pay anyone, anywhere, instantly.**

Orchid is a self-custodial dollar wallet for Latin America. Send dollars to a username or drop a link in WhatsApp, and the other person receives them in Orchid, in any wallet or exchange, or as soles in Yape, without installing anything. Your keys never leave your phone, and Orchid never holds your money.

## One link, straight to Yape

> Rosa works in Madrid. She opens Orchid, types 50, taps **Crear link de pago** and sends it to her mother in Arequipa on WhatsApp.
>
> Her mother taps the link, enters her phone number, sees "Recibirás S/ 187.40" and taps **Recibir en Yape**. Seconds later, the soles are in her Yape.
>
> No app to install, no account to open, no crypto to understand. Until the link is claimed, the money is held by the link itself, never by Orchid.

## Why Orchid

- **Pay anyone.** A `@username`, a payment link, a Stellar address, an exchange, or a Yape account. Recipients choose how they receive.
- **Your money, your keys.** A passkey (Face ID or fingerprint) protects a standard recovery phrase that lives only on your device. Export it anytime and open the same wallet in other apps.
- **Nothing to learn.** No gas, no XLM, no networks, no trustlines. Orchid sponsors every account and pays every network fee.
- **Money that doesn't get lost.** Orchid checks every destination before you sign: exchanges that need a memo, accounts that can't receive yet, deposit addresses on the wrong network. Every payment has a status you can follow, in plain Spanish.
- **Dollars that work.** Idle dollars earn yield in **Ahorro**, and the same balance buys Bitcoin and tokenized US stocks, all in one confirmation.

## How it works

| Layer                                     | What Orchid does                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payments on Stellar**                   | Usernames, USDC payments in seconds, sponsored accounts and fee bumps, so users hold no XLM. Payment links are funds held on-chain that only the link can claim, and the sender can take back anytime.                       |
| **One phrase, every network**             | The device derives Stellar and Solana accounts from the same phrase. One balance on screen; USDC moves between networks behind the scenes with Circle's CCTP, burned on one and minted on the other, with no wrapped tokens. |
| **The phone approves everything**         | Orchid's server drafts each transaction; the phone checks that it does exactly what the user asked (recipient, asset, amount, memo) and only then signs.                                                                     |
| **Local money through licensed partners** | A licensed payment partner turns USDC into soles and pays out to Yape, Plin and banks over Peru's interoperable payment network.                                                                                             |
| **Yield and investing**                   | Ahorro deposits into a DeFindex vault lending through Blend. Swaps route through Soroswap on Stellar and Jupiter on Solana, where tokenized stocks (xStocks) and Bitcoin (cbBTC) trade.                                      |
| **USDT from anywhere**                    | USDT sent on Tron, the default for many exchanges in the region, arrives as USDC.                                                                                                                                            |

## Business model

Sending and receiving are free; that is how Orchid spreads. Revenue comes from what people do with their dollars:

- **Ahorro:** 10% of the yield earned, never a fee on deposits.
- **Swaps and investing:** 0.5% per trade.
- **Cash-out to Yape, Plin and banks:** a small spread over the partner's rate.

## Roadmap

| Stage                       | Features                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Live on Stellar testnet** | Permanent usernames, sponsored accounts, passkey backup and restore, USDC payments engine with exchange memos, reserve recovery |
| **Next**                    | Sending from the app, payment links, memo checks against the ledger, activity, accounts that open on first deposit              |
| **Then**                    | Payouts to Yape and Plin, Ahorro, swaps, Solana with tokenized stocks and Bitcoin, USDT from Tron                               |

## Built with

Stellar (classic accounts, sponsored reserves, fee bumps, claimable balances, Soroban), Circle USDC and CCTP, Solana, passkeys (WebAuthn PRF), Cloudflare Workers and Hyperdrive, Neon Postgres, TanStack Start, React, Effect, Drizzle, Bun, Tailwind CSS, shadcn, Base UI.

## Run it locally

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

Fund each public key with Friendbot (`https://friendbot.stellar.org/?addr=G...`). `STELLAR_RPC_URL` and `PASSKEY_ORIGINS` (the comma-separated origins whose passkeys the server accepts) are set in `apps/web/wrangler.jsonc`. Testnet resets wipe both accounts; fund them again afterwards.

`bun run --cwd apps/web test:e2e` builds the app, serves it with `vite preview`, and creates and restores real testnet wallets in Chromium with a virtual passkey (`bunx playwright install chromium` once). It needs the database above and `apps/web/.dev.vars`. Restart an existing database with `docker start orchid-postgres`.

Wrangler config supplies `nodejs_compat` and the local Docker connection string. `bun run dev` uses Docker even when Neon credentials exist in the root `.env.local`. Override the local connection string if needed:

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='postgres://orchid:orchid-local@127.0.0.1:55432/orchid'
bun run dev
```

Local Hyperdrive connects directly to Postgres without production pooling or caching. The configured Hyperdrive ID is used for the deployed Worker.

To develop against Neon, `bunx neon checkout dev` selects the database branch and pulls its credentials into the gitignored root `.env.local`. `bun run db:migrate` applies wallet migrations through `DATABASE_URL_UNPOOLED`. `bun run --cwd apps/web dev:neon` uses that URL for its local Hyperdrive connection; an explicit `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` takes precedence.

`packages/db` exports `makeDatabase` and `databaseLayer`; the web server builds the layer from `env.HYPERDRIVE` inside each request. Wallet tables and their Drizzle migrations live in `packages/wallet`; see the [wallet README](packages/wallet/README.md) for its behaviour, tests and the Hyperdrive caching prerequisite for deployment. The design rationale is in [docs/architecture/wallet-testnet](docs/architecture/wallet-testnet/rationale.md).

Design tokens (Figma Light/Dark variables as shadcn CSS variables) live in `packages/ui/src/styles/tokens.css`.

Checks: `bun run typecheck`, `bun run lint`, `bun run fmt:check`, `bun run build`. Format: `bun run fmt`. Production preview: `bun run --cwd apps/web preview`.

## Team

Marcelo Vizcarra · https://mavix.dev

## License

[Apache License 2.0](LICENSE)
