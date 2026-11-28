import { Database } from "@workspace/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  AssetOrder,
  type AssetOrderId,
  type UnclaimedFundsId,
} from "../contract";
import { approvalMargin, sweepBatchSize } from "../policy";
import { epochAt, network } from "../record-network";
import type { Sealed } from "./Chain.server";
import { StoreFailure } from "./Directory.server";
import {
  type AssetProposed,
  type StoredAssetOrder,
  type StoredOrder,
  StoredExternalOrder,
} from "./asset-order-records.server";
import { SlotOccupied, walletLock } from "./slot.server";
import { assetOrders, transfers, usernames, wallets } from "./tables.server";
import type { Transaction } from "./transaction.server";

type Decode = (
  row: typeof assetOrders.$inferSelect,
) => Effect.Effect<StoredAssetOrder, StoreFailure>;

export const scopeAt = (now: number) =>
  and(
    eq(assetOrders.network, network),
    eq(assetOrders.testnetEpoch, epochAt(now)),
  );

export const ordersOnUnclaimedFunds = Effect.fn("AssetOrders.onUnclaimedFunds")(
  function* (unclaimedFunds: UnclaimedFundsId, decode: Decode) {
    const db = yield* Database;
    const now = yield* Clock.currentTimeMillis;

    const rows = yield* db
      .select()
      .from(assetOrders)
      .where(and(scopeAt(now), eq(assetOrders.balanceId, unclaimedFunds)))
      .orderBy(desc(assetOrders.createdAt))
      .limit(sweepBatchSize * 4);

    return yield* Effect.forEach(rows, decode);
  },
);

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

export const authorizeExternalOrder = (
  proposed: AssetProposed,
  sealed: Sealed,
  decode: Decode,
) =>
  Effect.gen(function* () {
    const db = yield* Database;

    if (!(proposed.order instanceof StoredExternalOrder))
      return yield* new StoreFailure({
        cause: new Error("External authorization requires an external order"),
      });

    const { id, action } = proposed.order;

    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.execute(walletLock(action.link));

        const lockedAt = yield* Clock.currentTimeMillis;
        const scope = scopeAt(lockedAt);

        const held = yield* tx
          .select({ id: assetOrders.id })
          .from(assetOrders)
          .where(
            and(
              scope,
              eq(assetOrders.balanceId, action.unclaimedFunds),
              eq(assetOrders.status, "authorized"),
            ),
          );

        if (held.some((row) => row.id !== id)) return new SlotOccupied();

        const commitAt = yield* Clock.currentTimeMillis;

        const written = yield* tx
          .update(assetOrders)
          .set({
            status: "authorized",
            envelope: sealed.envelope,
            hash: sealed.hash,
          })
          .where(
            and(
              scope,
              eq(assetOrders.id, id),
              eq(assetOrders.status, "proposed"),
              eq(assetOrders.envelope, proposed.request.envelope),
              gt(
                assetOrders.expiresAt,
                DateTime.toDateUtc(
                  DateTime.makeUnsafe(commitAt + approvalMargin * 1000),
                ),
              ),
            ),
          )
          .returning();

        if (written[0]) return yield* decode(written[0]);

        const fresh = yield* tx
          .select()
          .from(assetOrders)
          .where(and(scope, eq(assetOrders.id, id)));

        if (!fresh[0])
          return yield* new StoreFailure({
            cause: new Error("Asset order disappeared"),
          });

        return yield* decode(fresh[0]);
      }),
    );
  });

export const openedWallet = (order: StoredOrder) =>
  order instanceof AssetOrder && Predicate.isTagged(order.action, "ReceiveLink")
    ? sql`exists (
        select 1 from ${wallets}
        where ${wallets.address} = ${order.wallet}
          and ${wallets.network} = ${network}
          and ${wallets.status} = 'opening'
      ) and not exists (
        select 1 from ${usernames}
        where ${usernames.address} = ${order.wallet}
      )`
    : false;

export const closeUnclaimedFunds = (
  tx: Transaction,
  unclaimedFunds: UnclaimedFundsId,
  now: DateTime.Utc,
) =>
  tx
    .update(transfers)
    .set({ balanceClosedAt: DateTime.toDateUtc(now) })
    .where(
      and(
        eq(transfers.balanceId, unclaimedFunds),
        isNull(transfers.balanceClosedAt),
      ),
    )
    .pipe(Effect.asVoid);
