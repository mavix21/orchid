import { Database } from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { AssetOrderId, BalanceId } from "../contract";
import { epochAt, network, sweepBatchSize } from "../stellar/network";
import type { AssetConcluded, StoredAssetOrder } from "./AssetOrders.server";
import { StoreFailure } from "./Directory.server";
import { assetOrders } from "./tables.server";

type Decode = (
  row: typeof assetOrders.$inferSelect,
) => Effect.Effect<StoredAssetOrder, StoreFailure>;

const scopeAt = (now: number) =>
  and(
    eq(assetOrders.network, network),
    eq(assetOrders.testnetEpoch, epochAt(now)),
  );

export const ordersOnBalance = Effect.fn("AssetOrders.onBalance")(function* (
  balance: BalanceId,
  decode: Decode,
) {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;

  const rows = yield* db
    .select()
    .from(assetOrders)
    .where(and(scopeAt(now), eq(assetOrders.balanceId, balance)))
    .orderBy(desc(assetOrders.createdAt))
    .limit(sweepBatchSize * 4);

  return yield* Effect.forEach(rows, decode);
});

export const receivedLinksToClean = Effect.fn(
  "AssetOrders.receivedLinksToClean",
)(function* (decode: Decode) {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;

  const rows = yield* db
    .select()
    .from(assetOrders)
    .where(
      and(
        scopeAt(now),
        eq(assetOrders.status, "settled"),
        isNull(assetOrders.linkCleanedAt),
        sql`${assetOrders.order}::jsonb -> 'action' ->> '_tag' = 'ReceiveLink'`,
      ),
    )
    .orderBy(assetOrders.concludedAt)
    .limit(sweepBatchSize);

  return yield* Effect.forEach(rows, (row) =>
    Effect.flatMap(
      decode(row),
      (stored): Effect.Effect<AssetConcluded, StoreFailure> =>
        Predicate.isTagged(stored, "AssetConcluded")
          ? Effect.succeed(stored)
          : Effect.fail(
              new StoreFailure({
                cause: new Error("Settled asset order is not concluded"),
              }),
            ),
    ),
  );
});

export const linkCleaned = Effect.fn("AssetOrders.linkCleaned")(function* (
  id: AssetOrderId,
) {
  const db = yield* Database;
  const now = yield* DateTime.now;

  yield* db
    .update(assetOrders)
    .set({ linkCleanedAt: DateTime.toDateUtc(now) })
    .where(
      and(
        scopeAt(DateTime.toEpochMillis(now)),
        eq(assetOrders.id, id),
        isNull(assetOrders.linkCleanedAt),
      ),
    );
});
