# Sketch: module map

Part of the [sketch index](sketch.md). Package layout and how its boundaries are enforced.

## 3. Module map

```
packages/wallet/                         "@workspace/wallet"
  package.json   exports: { ".": "./src/index.ts", "./server": "./src/server/index.server.ts" }
  src/
    index.ts                 device entry: Wallet, values, errors, formatUsdc, type WalletRelay
    values.ts                Username, Usdc, Address, TransferId, Envelope, Profile, Transfer, Overview, TransferDraft
    errors.ts                Schema.TaggedError classes shared by device and wire
    protocol.ts              the only list of calls and their replies
    stellar/
      network.ts             passphrase, USDC asset, deadline and fee policy (one place)
      enrollment-tx.ts       server builds, device checks: the enrollment sandwich
      transfer-tx.ts         device builds, server reads and checks: the payment
    device/
      wallet.ts              Wallet layer: create, overview, preview, send
      keystore.ts            IndexedDB: key + profile (only writer)
      outbox.ts              IndexedDB: unacknowledged envelope + last signed sequence (only writer)
      relay.ts               typed call over WalletRelay; maps transport failure to WalletOffline
    server/
      index.server.ts        server entry: walletCall, walletServerLayer
      serve.server.ts        exhaustive dispatch of WalletCall
      directory.server.ts    usernames to addresses (only writer of `wallets`)
      transfers.server.ts    submit + reconcile (only writer of `transfers`)
      sponsor.server.ts      the only holder of the sponsor secret: enrollment offers, fee bumps
      chain.server.ts        the only importer of @stellar/stellar-sdk/rpc
      tables.server.ts       Drizzle tables, not exported

apps/web/src/server/wallet.ts   callWallet server function (above)
apps/web/src/wallet.ts          ManagedRuntime (above)
apps/web/src/routes/...         UI only
```

How the boundaries are enforced:

- **Deep imports.** The `exports` map exposes only two entries, so `@workspace/wallet/src/...` fails module resolution in typecheck and in build. No `paths` alias may be added for this package; the existing `@workspace/ui/*` alias does bypass `exports`.
- **Server code in the client.** Every server file is named `*.server.ts`, so Start import protection fails `bun run build` if client code pulls one in. That includes `device/*` importing `server/*` by relative path.

New dependency: `@stellar/stellar-sdk@17.4.0` in `packages/wallet`. The device imports only `@stellar/stellar-sdk/base`, and only `chain.server.ts` imports `/rpc`. The package does not depend on `@tanstack/react-start`. No other stack is added, and IndexedDB is used directly with no wrapper library.
