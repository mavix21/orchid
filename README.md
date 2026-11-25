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

- **Pay anyone.** A `@username`, a payment link, an exchange, a Yape account, or an address on Stellar, Solana, Base and other networks. Recipients choose how they receive.
- **Your money, your keys.** A standard recovery phrase stays on your device, sealed at rest by a passkey (Face ID or fingerprint) that every payment asks for again. The passkey proves it's you but never shows the payment, so Orchid's review screen is what tells you what you sign, and while you approve, the phrase sits in the app's memory, where code running on your phone could read it and the browser cannot promise to wipe it. Export it anytime and open the same wallet in other apps.
- **Nothing to learn.** No gas, no XLM, no networks, no trustlines. Orchid sponsors every account and pays every network fee.
- **Money that doesn't get lost.** Orchid checks every destination before you sign: exchanges that need a memo, accounts that can't receive yet, deposit addresses on the wrong network. Every payment has a status you can follow, in plain Spanish.
- **Dollars that work.** Idle dollars earn yield in **Ahorro**, and the same balance buys Bitcoin and tokenized US stocks, all in one confirmation.

## How it works

| Layer                                     | What Orchid does                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payments on Stellar**                   | Usernames, USDC payments in seconds, sponsored accounts and fee bumps, so users hold no XLM. Payment links are funds held on-chain that only the link can claim, and the sender can take back anytime.                       |
| **One phrase, every network**             | The device derives Stellar and Solana accounts from the same phrase. One balance on screen; USDC moves between networks behind the scenes with Circle's CCTP, burned on one and minted on the other, with no wrapped tokens. |
| **The phone approves everything**         | Orchid's server drafts each transaction; the phone checks that it does exactly what the user asked (recipient, asset, amount, memo), shows it, and signs only after a fresh passkey check.                                   |
| **Local money through licensed partners** | A licensed payment partner turns USDC into soles and pays out to Yape, Plin and banks over Peru's interoperable payment network.                                                                                             |
| **Yield and investing**                   | Ahorro deposits into a DeFindex vault lending through Blend. Swaps route through Soroswap on Stellar and Jupiter on Solana, where tokenized stocks (xStocks) and Bitcoin (cbBTC) trade.                                      |
| **USDT from anywhere**                    | USDT sent on Tron, the default for many exchanges in the region, arrives as USDC.                                                                                                                                            |

## Business model

Sending and receiving are free; that is how Orchid spreads. Revenue comes from what people do with their dollars:

- **Ahorro:** 10% of the yield earned, never a fee on deposits.
- **Swaps and investing:** 0.5% per trade.
- **Cash-out to Yape, Plin and banks:** a small spread over the partner's rate.

## Roadmap

| Stage                       | Features                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live on Stellar testnet** | Permanent usernames, sponsored accounts, passkey backup and restore, USDC payments from the app with exchange memos checked against the ledger |
| **Next**                    | Payment links, activity, deposits from Solana and Tron                                                                                         |
| **Then**                    | Sending to Solana, Base and other networks, payouts to Yape and Plin, Ahorro, swaps, tokenized stocks and Bitcoin                              |

## Built with

Stellar (classic accounts, sponsored reserves, fee bumps, claimable balances, Soroban), Circle USDC and CCTP, Solana, passkeys (WebAuthn PRF), Cloudflare Workers and Hyperdrive, Neon Postgres, TanStack Start, React, Effect, Drizzle, Bun, Tailwind CSS, shadcn, Base UI.

## Run it locally

Install Bun, Node 22.12 or newer and Docker Desktop, then run:

```sh
bun run setup
bun run dev
```

Open http://localhost:3000.

`bun run setup` is safe to repeat. It installs dependencies, creates or starts the `orchid-postgres` container on port 55432, applies the migrations and fills the gitignored `apps/web/.dev.vars`. Add `--e2e` (`bun run setup --e2e`) to also install Playwright's Chromium.

Creating an account opens it on the network, which needs two funded testnet accounts: the reserve sponsor and the fee payer. Setup creates both, funds them with Friendbot and writes their secret keys to `.dev.vars` as `RESERVE_SPONSOR_SECRET` and `FEE_PAYER_SECRET`, printing only the public keys. Testnet resets wipe both accounts; running setup again funds them anew. It also writes a random `SESSION_SECRET` and Cloudflare's documented Turnstile test pair, `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, which override the real site key in `apps/web/wrangler.jsonc` locally. Keys already in `.dev.vars` are kept. In a worktree, setup links the main checkout's `.dev.vars` instead of creating new accounts.

Deploys use the real Turnstile pair: the site key in `wrangler.jsonc` and the secret with `wrangler secret put TURNSTILE_SECRET_KEY`. `STELLAR_RPC_URL` and `PASSKEY_ORIGINS` (the comma-separated origins whose passkeys the server accepts) are also set in `apps/web/wrangler.jsonc`.

`bun run --cwd apps/web test:e2e` builds the app, serves it with `vite preview`, and creates and restores real testnet wallets in Chromium with a virtual passkey (`bun run setup --e2e` once). It needs Docker. If `apps/web/.dev.vars` exists, the run uses its reserve sponsor and fee payer: the build copies them into the gitignored `apps/web/dist/server/.dev.vars`, which `vite preview` reads. Otherwise it creates a fresh pair, funds both with Friendbot and passes them only to the `vite preview` process as environment variables, so no key is written to disk. It never touches the database above: it starts a throwaway `orchid-e2e-database` container on port 55434, applies the migrations, points the preview server at it, and removes it when the run ends. Restart the development database with `docker start orchid-postgres`.

Wrangler config supplies `nodejs_compat` and the local Docker connection string. `bun run dev` uses Docker even when Neon credentials exist in the root `.env.local`. Override the local connection string if needed:

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='postgres://orchid:orchid-local@127.0.0.1:55432/orchid'
bun run dev
```

Local Hyperdrive connects directly to Postgres without production pooling or caching. The configured Hyperdrive ID is used for the deployed Worker.

To develop against Neon, `bunx neon checkout dev` selects the database branch and pulls its credentials into the gitignored root `.env.local`. `bun run db:migrate` applies wallet migrations through `DATABASE_URL_UNPOOLED`. `bun run --cwd apps/web dev:neon` uses that URL for its local Hyperdrive connection; an explicit `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` takes precedence.

`packages/db` exports `Database` and `databaseLayer`; the web server builds the layer from `env.HYPERDRIVE` inside each request. Wallet tables and their Drizzle migrations live in `packages/wallet`; see the [wallet README](packages/wallet/README.md) for its behaviour, tests and the Hyperdrive caching prerequisite for deployment. The design rationale is in [docs/architecture/wallet-testnet](docs/architecture/wallet-testnet/rationale.md).

## Team

Marcelo Vizcarra · https://mavix.dev

## License

[Apache License 2.0](LICENSE)
