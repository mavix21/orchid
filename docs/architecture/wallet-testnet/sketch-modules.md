# Sketch: module map and usage

Part of the [core wallet flow sketch](sketch.md). How the package is laid out and how callers use it.

## 2. Module map

One new package. Nothing else is added.

```text
packages/wallet/                    @workspace/wallet
  package.json                      exports "." and "./server" and nothing else
  src/
    index.ts                        CONTRACT   shared types and device client exports
    contract/                       internal   schema files behind index.ts
    stellar/                        internal   the only code that knows Stellar's format
      network.ts                               passphrase, USDC asset, time-bound policy
      envelopes.ts                             draft a transaction; read one back
    server/
      index.server.ts               SERVER     exports Wallet, WalletSettings
      Wallet.ts                                orchestrates the three below
      Directory.ts                  internal   usernames and addresses. Only writer of `wallets`
      Transfers.ts                  internal   exactly-once record. Only writer of `transfers`
      Chain.ts                      internal   RPC calls, sponsor signatures, settlement
      tables.ts                     internal   Drizzle tables
    device/
      index.ts                      DEVICE     re-exported by the root entry
      client.ts                     internal   the approve-and-replay loop
      Keyring.ts                    internal   the key, and the only code that signs

apps/web/src/
  server/wallet.ts                  builds the per-request layer, like server/db.ts
  server.ts                         Worker entry: fetch + scheduled sweep
  wallet/port.functions.ts          three server functions and their client half
  wallet/index.ts                   export const wallet = connectWallet(port)
```

What each module knows that no other module does:

| Module      | Its secret                                                                          |
| ----------- | ----------------------------------------------------------------------------------- |
| `stellar/`  | Operation layouts, the sponsorship sandwich, fee bumps, XDR, the network passphrase |
| `Chain`     | The RPC API, reserve sponsor and fee payer keys, and settlement evidence            |
| `Transfers` | The state machine, the one-in-flight rule, the SQL that makes transitions atomic    |
| `Directory` | Username rules, claim expiry, the mapping table                                     |
| `Keyring`   | Where the key lives, how it is created, what must be true before it signs           |
| `client`    | The replay loop and the polling schedule                                            |
| App files   | TanStack server functions, Cloudflare bindings                                      |

The modules are split by what they know, not by when they run. Drafting, sealing and submitting all sit in `Chain` because they share one secret.

## 3. Usage

The UI imports one value.

```tsx
// apps/web/src/routes/index.tsx — home screen
import { createFileRoute } from "@tanstack/react-router";
import * as Match from "effect/Match";
import { formatUsdc } from "@workspace/wallet";
import { wallet } from "@/wallet";

export const Route = createFileRoute("/")({
  ssr: false, // the key lives in the browser, so this loader cannot run on the server
  loader: () => wallet.overview(),
  component: Home,
});

function Home() {
  const overview = Route.useLoaderData();

  return Match.valueTags(overview, {
    NoWallet: () => <Welcome />,
    Offline: () => <OfflineNotice />,
    Holding: ({ profile, balance, latest }) => (
      <Balance
        username={profile.username}
        amount={formatUsdc(balance)}
        latest={latest}
      />
    ),
  });
}
```

```tsx
// apps/web/src/routes/send.tsx — the send button
const router = useRouter();

async function onConfirm(recipientText: string, amountText: string) {
  const outcome = await wallet.send(recipientText, amountText);

  Match.valueTags(outcome, {
    Settled: (receipt) => showSent(receipt),
    Pending: (receipt) => showOnItsWay(receipt), // durable: the server will finish it
    Failed: (receipt) => showNotSent(receipt), // proven: it can never arrive
    SenderBusy: ({ inFlight }) => showOnItsWay(inFlight),
    InsufficientBalance: ({ available }) => showTooMuch(available),
    UnknownRecipient: () => showNoSuchUser(),
    InvalidRecipient: () => showBadUsername(),
    InvalidAmount: () => showBadAmount(),
    NoWallet: () => router.navigate({ to: "/welcome" }),
    DraftRejected: () => showSecurityStop(),
    Offline: () => showTryAgain(), // nothing was signed, or the answer is on the home screen
  });

  await router.invalidate();
}
```

```tsx
// apps/web/src/routes/welcome.tsx — create a wallet
async function onSubmit(usernameText: string) {
  const outcome = await wallet.create(usernameText);

  Match.valueTags(outcome, {
    Opened: () => router.navigate({ to: "/" }),
    UsernameTaken: () => showTaken(),
    AddressBound: ({ profile }) => showExistingName(profile),
    InvalidUsername: () => showRules(),
    UnsupportedDevice: () => showUpdateBrowser(),
    DraftRejected: () => showSecurityStop(),
    Offline: () => showTryAgain(), // safe to press again: opening converges
  });
}
```

Three things the caller never does: it never retries, never polls, and never sees a transaction. Every outcome is a value, so adding one breaks the build at each call site until it is handled.
