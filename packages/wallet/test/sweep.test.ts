import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  accountState,
  amount,
  create,
  findWallet,
  settleHash,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "recovery sweep checks time, balance and sequence before submitting",
      () =>
        Effect.gen(function* () {
          const claim = yield* create(Keypair.random(), "maria");
          const initial = world.submitted.length;

          const openedSequence = Option.getOrThrow(
            Option.fromNullishOr(world.accounts.get(claim.address)),
          ).sequence;

          yield* sweep;
          expect(world.submitted).toHaveLength(initial);
          yield* Database.use((db) =>
            db.execute(
              sql`update wallets set "recoveryMinTime" = now() - interval '1 second' where address = ${claim.address}`,
            ),
          );

          const zero = Option.some(amount("0"));

          for (const state of [
            accountState({ balance: Option.some(amount("1")) }),
            accountState({
              sequence: (BigInt(openedSequence) + 1n).toString(),
              balance: zero,
            }),
            accountState({ nativeBalance: 1n, balance: zero }),
          ]) {
            world.accounts.set(claim.address, state);
            yield* sweep;
            expect(world.submitted).toHaveLength(initial);
          }

          world.accounts.set(
            claim.address,
            accountState({ sequence: openedSequence, balance: zero }),
          );
          yield* sweep;
          expect(world.submitted).toHaveLength(initial + 1);

          const submitted = world.submitted.at(-1);

          if (!submitted) throw new Error("Expected recovery submission");

          settleHash(submitted.hash);
          yield* sweep;
          expect(
            (yield* findWallet(claim.address)).pipe(
              Option.map((r) => r.status),
            ),
          ).toEqual(Option.some("recovered"));
        }),
    );
  },
);
