# Sketch: caller's view

Part of the [sketch index](sketch.md). What UI code calls, and what it never sees.

## 1. Caller's view first

UI code needs four things: does this device have a wallet, create one, show balance and activity, and send. Everything below is derived from these call sites.

```ts
// apps/web/src/wallet.ts — the only wiring the app does on the client side
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Wallet } from "@workspace/wallet";
import { callWallet } from "@/server/wallet";

export const wallet = ManagedRuntime.make(Wallet.layer(callWallet));
```

```ts
// apps/web/src/server/wallet.ts — the single server function; the app's only server-side wiring
import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { env } from "cloudflare:workers";
import { walletCall, walletServerLayer } from "@workspace/wallet/server";
import { requestDatabaseLayer } from "./db";

const requestWalletLayer = Layer.suspend(() =>
  walletServerLayer({
    sponsorSecret: Redacted.make(env.ORCHID_SPONSOR_SECRET),
    rpcUrl: env.STELLAR_RPC_URL,
  }),
).pipe(Layer.provide(requestDatabaseLayer));

export const callWallet = createServerFn({ method: "POST" })
  .validator(walletCall.validator)
  .handler(({ data }) =>
    Effect.runPromise(
      walletCall.serve(data).pipe(Effect.provide(requestWalletLayer)),
    ),
  );
```

**Call site 1: gate wallet routes on a local key.** No network call, so first paint is instant on a slow phone.

```tsx
// apps/web/src/routes/_wallet.tsx
export const Route = createFileRoute("/_wallet")({
  ssr: false,
  beforeLoad: async () => {
    const profile = await wallet.runPromise(Wallet.use((w) => w.profile));
    if (Option.isNone(profile)) throw redirect({ to: "/welcome" });
    return { profile: profile.value };
  },
});
```

**Call site 2: create a wallet with a username.**

```tsx
// apps/web/src/routes/welcome.tsx (ssr: false)
const createWallet = (username: string) =>
  wallet.runPromise(
    Wallet.use((w) => w.create(username)).pipe(
      Effect.as(Option.none<string>()),
      Effect.catchTags({
        UsernameInvalid: () => Effect.succeed(Option.some(copy.usernameRules)),
        UsernameTaken: (e) =>
          Effect.succeed(Option.some(copy.taken(e.username))),
        WalletOffline: () => Effect.succeed(Option.some(copy.offline)),
      }),
    ),
  );
```

**Call site 3: home, then review, then confirm.**

```tsx
// apps/web/src/routes/_wallet/index.tsx
loader: () => wallet.runPromise(Wallet.use((w) => w.overview)),
// component: formatUsdc(overview.available), overview.activity.map(row => <TransferRow transfer={row} />)

// apps/web/src/routes/_wallet/send.tsx
const review = (to: string, amount: string) => wallet.runPromiseExit(Wallet.use((w) => w.preview(to, amount)));
// screen shows draft.recipient.username and formatUsdc(draft.amount); the user taps "Yapear"
const confirm = (draft: TransferDraft) => wallet.runPromise(Wallet.use((w) => w.send(draft)));
// confirm resolves to a Transfer whose status is "sending" | "pending" | "sent" | "not_sent"
```

What the caller never sees: keys, XDR, sequence numbers, time bounds, sponsorship, fee bumps, RPC statuses, retries, the outbox, idempotency keys, or tables.
