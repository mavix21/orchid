import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { sweepBatchSize } from "../src/stellar/network";
import { assertTagged } from "./tagged";
import {
  accountState,
  amount,
  authorizeTransfer,
  create,
  findTransfer,
  findWallet,
  fundedWallet,
  selfOrder,
  settleHash,
  sweep,
  sweepNow,
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
            accountState({
              sequence: openedSequence,
              balance: Option.some(amount("1")),
            }),
            accountState({
              sequence: (BigInt(openedSequence) + 1n).toString(),
              balance: zero,
            }),
            accountState({
              sequence: openedSequence,
              nativeBalance: 1n,
              balance: zero,
            }),
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

    it.effect(
      "the sweep leaves a record stuck for under five minutes to the queue and picks it up once older",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);
          const { authorized } = yield* authorizeTransfer(key, order);

          settleHash(authorized.sealed.hash);
          yield* sweepNow;
          assertTagged(
            Option.getOrThrow(yield* findTransfer(order.id)),
            "Authorized",
          );

          yield* sweep;
          assertTagged(
            Option.getOrThrow(yield* findTransfer(order.id)),
            "Concluded",
          );
        }),
    );

    it.effect(
      "one sweep run drains more stuck records than a batch and tries an unresolved one once",
      () =>
        Effect.gen(function* () {
          const names = Array.from(
            { length: sweepBatchSize + 2 },
            (_, index) => `drain${"abcdefgh"[index]}`,
          );

          const stuck = yield* Effect.forEach(names, (name) =>
            Effect.gen(function* () {
              const key = yield* fundedWallet(name);
              const order = selfOrder(key);

              return {
                order,
                authorized: (yield* authorizeTransfer(key, order)).authorized,
              };
            }),
          );

          const [unresolved, ...decided] = stuck;

          if (!unresolved) throw new Error("Expected stuck records");

          for (const { authorized } of decided)
            settleHash(authorized.sealed.hash);

          const submissionsOf = (hash: string) =>
            world.submitted.filter((sealed) => sealed.hash === hash).length;

          const before = submissionsOf(unresolved.authorized.sealed.hash);

          yield* sweep;

          for (const { order } of decided)
            assertTagged(
              Option.getOrThrow(yield* findTransfer(order.id)),
              "Concluded",
            );

          assertTagged(
            Option.getOrThrow(yield* findTransfer(unresolved.order.id)),
            "Authorized",
          );
          expect(submissionsOf(unresolved.authorized.sealed.hash)).toBe(
            before + 1,
          );
        }),
    );
  },
);
