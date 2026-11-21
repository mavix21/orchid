import { env } from "cloudflare:workers";
import { databaseLayer } from "@workspace/db";
import { ServerFailure } from "@workspace/wallet";
import {
  Wallet,
  WalletSettings,
  concealFailure,
} from "@workspace/wallet/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const requestWalletLayer = Layer.suspend(() =>
  Wallet.layer.pipe(
    Layer.provide(
      Layer.succeed(WalletSettings, {
        rpcUrl: env.STELLAR_RPC_URL,
        reserveSponsorSecret: Redacted.make(env.RESERVE_SPONSOR_SECRET),
        feePayerSecret: Redacted.make(env.FEE_PAYER_SECRET),
        passkeyOrigins: env.PASSKEY_ORIGINS.split(","),
      }),
    ),
    Layer.provide(databaseLayer(env.HYPERDRIVE)),
    Layer.provide(FetchHttpClient.layer),
  ),
);

const concealed = <A, E>(program: Effect.Effect<A, E, Wallet>) =>
  program.pipe(
    Effect.provide(requestWalletLayer),
    Effect.catchCause(concealFailure),
  );

export function runWallet<A>(
  program: Effect.Effect<A, ServerFailure, Wallet>,
): Promise<A> {
  return Effect.runPromise(concealed(program));
}

export function answerWallet<C, D, A, I>(
  call: Schema.Codec<C, D>,
  data: D,
  step: Schema.Codec<A, I>,
  program: (decoded: C) => Effect.Effect<A, ServerFailure, Wallet>,
): Promise<I | typeof ServerFailure.Encoded> {
  return Effect.runPromise(
    concealed(
      Schema.decodeEffect(call)(data).pipe(
        Effect.flatMap(program),
        Effect.flatMap(Schema.encodeEffect(step)),
      ),
    ).pipe(
      Effect.catch((failure) =>
        Effect.succeed(Schema.encodeSync(ServerFailure)(failure)),
      ),
    ),
  );
}
