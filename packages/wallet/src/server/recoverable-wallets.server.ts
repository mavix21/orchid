import { Database } from "@workspace/db";
import { and, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { epochAt, network, sweepBatchSize } from "../stellar/network";
import type { WalletRow } from "./Directory.server";
import { wallets } from "./tables.server";

export const markRecoverable = Effect.fn("Directory.recoverable")(function* () {
  const db = yield* Database;
  const scope = eq(wallets.network, network);
  const now = yield* DateTime.now;
  const nowDate = DateTime.toDateUtc(now);

  return yield* db
    .update(wallets)
    .set({ sweepCheckedAt: nowDate })
    .where(
      and(
        scope,
        eq(wallets.status, "active"),
        lte(wallets.recoveryMinTime, nowDate),
        gt(wallets.recoveryMaxTime, nowDate),
        inArray(
          wallets.address,
          db
            .select({ address: wallets.address })
            .from(wallets)
            .where(
              and(
                scope,
                eq(wallets.testnetEpoch, epochAt(DateTime.toEpochMillis(now))),
                eq(wallets.status, "active"),
                isNotNull(wallets.recoveryEnvelope),
                lte(wallets.recoveryMinTime, nowDate),
                gt(wallets.recoveryMaxTime, nowDate),
              ),
            )
            .orderBy(
              sql`${wallets.sweepCheckedAt} asc nulls first`,
              wallets.address,
            )
            .limit(sweepBatchSize),
        ),
      ),
    )
    .returning();
});

export const markRecovered = Effect.fn("Directory.recover")(function* (
  row: WalletRow,
) {
  const db = yield* Database;

  yield* db
    .update(wallets)
    .set({
      status: "recovered",
      version: row.version + 1,
      attemptEnvelope: null,
      attemptHash: null,
      attemptExpiresAt: null,
      recoveryDraft: null,
      recoveryEnvelope: null,
      recoveryHash: null,
      recoverySequence: null,
      recoveryMinTime: null,
      recoveryMaxTime: null,
      pairedRecoveryDraft: null,
      pairedRecoveryEnvelope: null,
      pairedRecoveryHash: null,
      depositOpening: sql`case when ${wallets.depositOpening} = 'attempted' then 'recovered' else ${wallets.depositOpening} end`,
    })
    .where(
      and(
        eq(wallets.network, network),
        eq(wallets.address, row.address),
        eq(wallets.version, row.version),
      ),
    );
});
