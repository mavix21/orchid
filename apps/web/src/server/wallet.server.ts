import { env } from "cloudflare:workers";
import { databaseLayer } from "@workspace/db";
import { Wallet, WalletSettings } from "@workspace/wallet/server";
import type { WalletUnavailable } from "@workspace/wallet";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const requestWalletLayer = Layer.suspend(() =>
  Wallet.layer.pipe(
    Layer.provide(
      Layer.succeed(WalletSettings, {
        rpcUrl: env.STELLAR_RPC_URL,
        reserveSponsorSecret: Redacted.make(env.RESERVE_SPONSOR_SECRET),
        feePayerSecret: Redacted.make(env.FEE_PAYER_SECRET),
      }),
    ),
    Layer.provide(databaseLayer(env.HYPERDRIVE)),
  ),
);

/** Pools and bindings are acquired and released within the current request. */
export function runWallet<A>(program: Effect.Effect<A, WalletUnavailable, Wallet>): Promise<A> {
  return Effect.runPromise(program.pipe(Effect.provide(requestWalletLayer)));
}
