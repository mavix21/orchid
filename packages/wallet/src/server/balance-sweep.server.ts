import type { makeDatabase } from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BalanceId } from "../contract";
import { epochAt, network, sweepBatchSize } from "../stellar/network";
import { transfers } from "./tables.server";

export const balancesToCheck = (
  db: Effect.Success<ReturnType<typeof makeDatabase>>,
) =>
  Effect.gen(function* () {
    // Only settled creations can be proven gone. An authorized transaction may
    // still create its balance after this read.
    const outstanding = and(
      eq(transfers.network, network),
      eq(transfers.testnetEpoch, epochAt(Date.now())),
      eq(transfers.status, "settled"),
      isNotNull(transfers.balanceId),
      isNull(transfers.balanceClosedAt),
    );

    const rows = yield* db
      .update(transfers)
      .set({ sweepCheckedAt: new Date() })
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
