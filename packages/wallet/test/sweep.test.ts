import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ExternalRecipient, ResolvedRecipient } from "../src/contract";
import { Directory } from "../src/server/Directory.server";
import { transfers, wallets } from "../src/server/tables.server";
import { OrderJson, Transfers } from "../src/server/Transfers.server";
import { epochAt, network, sweepBatchSize } from "../src/stellar/network";
import {
  accountState,
  addressOf,
  amount,
  create,
  findWallet,
  selfOrder,
  settleHash,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const RecipientJson = Schema.fromJsonString(ResolvedRecipient);

const activeRow = (
  address: string,
  now: number,
  minMs: number,
  maxMs: number,
) => ({
  address,
  status: "active" as const,
  network,
  testnetEpoch: epochAt(now),
  recoveryEnvelope: "envelope",
  recoveryHash: "0".repeat(64),
  recoverySequence: "1001",
  recoveryMinTime: new Date(now + minMs),
  recoveryMaxTime: new Date(now + maxMs),
});

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "recovery sweep checks time, balance and sequence before submitting",
      () =>
        Effect.gen(function* () {
          const claim = yield* create(Keypair.random(), "maria");
          const initial = world.submitted.length;

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
            accountState({ sequence: "1001", balance: zero }),
            accountState({ nativeBalance: 1n, balance: zero }),
          ]) {
            world.accounts.set(claim.address, state);
            yield* sweep;
            expect(world.submitted).toHaveLength(initial);
          }

          world.accounts.set(claim.address, accountState({ balance: zero }));
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
      "recovery queue excludes future and expired windows, caps and rotates eligible work",
      () =>
        Effect.gen(function* () {
          const db = yield* Database;
          const now = yield* Clock.currentTimeMillis;

          const windows: ReadonlyArray<readonly [number, number]> = [
            [3_600_000, 7_200_000],
            [-60_000, -1_000],
            ...Array.from(
              { length: sweepBatchSize },
              () => [-60_000, 3_600_000] as const,
            ),
          ];

          const addresses = windows.map(() => addressOf(Keypair.random()));
          const future = addresses[0];
          const expired = addresses[1];

          if (!future || !expired) throw new Error("Expected addresses");

          yield* db
            .insert(wallets)
            .values(
              windows.map(([minMs, maxMs], i) =>
                activeRow(addresses[i] ?? future, now, minMs, maxMs),
              ),
            );

          const first = yield* Directory.use((d) => d.recoverable);

          expect(first).toHaveLength(sweepBatchSize);
          expect(
            first.some((r) => r.address === future || r.address === expired),
          ).toBe(false);

          yield* db
            .update(wallets)
            .set({
              recoveryMinTime: new Date(now - 60_000),
              recoveryMaxTime: new Date(now + 3_600_000),
            })
            .where(eq(wallets.address, future));

          const second = yield* Directory.use((d) => d.recoverable);

          expect(second).toHaveLength(sweepBatchSize);
          expect(second.some((r) => r.address === future)).toBe(true);
        }),
    );

    it.effect(
      "transfer sweep queue caps and rotates signed work across senders",
      () =>
        Effect.gen(function* () {
          const db = yield* Database;
          const now = yield* Clock.currentTimeMillis;

          const senders = Array.from({ length: sweepBatchSize + 1 }, () =>
            Keypair.random(),
          );

          yield* db
            .insert(wallets)
            .values(
              senders.map((s) =>
                activeRow(addressOf(s), now, 60_000, 3_600_000),
              ),
            );
          const orders = senders.map((s) => selfOrder(s));

          yield* db.insert(transfers).values(
            orders.map((order) => ({
              id: order.id,
              sender: order.from,
              recipient: order.from,
              destination: order.from,
              order: Schema.encodeSync(OrderJson)(order),
              resolvedRecipient: Schema.encodeSync(RecipientJson)(
                new ExternalRecipient({ address: order.from }),
              ),
              amount: order.amount,
              network,
              testnetEpoch: epochAt(now),
              status: "authorized" as const,
              envelope: "envelope",
              hash: "0".repeat(64),
              expiresAt: new Date(now + 60_000),
            })),
          );

          const first = yield* Transfers.use((s) => s.inFlight);
          const next = yield* Transfers.use((s) => s.inFlight);
          const seen = new Set([...first, ...next].map((t) => t.order.id));

          expect(first).toHaveLength(sweepBatchSize);
          expect(next).toHaveLength(sweepBatchSize);
          expect(seen.size).toBe(orders.length);
        }),
    );
  },
);
