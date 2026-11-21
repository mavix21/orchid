import { Database } from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BalanceId } from "../contract";
import { epochAt, network, sweepBatchSize } from "../stellar/network";
import { transfers } from "./tables.server";

export const balancesToCheck = Effect.gen(function* () {
  const db = yield* Database;
  const now = yield* DateTime.now;

  const outstanding = and(
    eq(transfers.network, network),
    eq(transfers.testnetEpoch, epochAt(DateTime.toEpochMillis(now))),
    eq(transfers.status, "settled"),
    isNotNull(transfers.balanceId),
    isNull(transfers.balanceClosedAt),
  );

  const rows = yield* db
    .update(transfers)
    .set({ sweepCheckedAt: DateTime.toDateUtc(now) })
    .where(
      and(
        outstanding,
        inArray(
          transfers.id,
          db
            .select({ id: transfers.id })
            .from(transfers)
            .where(outstanding)
            .orderBy(
              sql`${transfers.sweepCheckedAt} asc nulls first`,
              transfers.id,
            )
            .limit(sweepBatchSize),
        ),
      ),
    )
    .returning({ balance: transfers.balanceId });

  return rows.flatMap((row) =>
    row.balance ? [Schema.decodeSync(BalanceId)(row.balance)] : [],
  );
});
