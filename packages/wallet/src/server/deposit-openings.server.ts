import type { Database } from "@workspace/db";
import {
  and,
  count,
  eq,
  exists,
  gt,
  isNotNull,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { DepositOpeningSpent, DepositOpeningsFull } from "../contract";
import { epochAt, network } from "../stellar/network";
import { deposits, transfers, wallets } from "./tables.server";

type Executor = Pick<Database["Service"], "select">;

type WalletRow = typeof wallets.$inferSelect;

export type DepositOpeningRefusal = DepositOpeningsFull | DepositOpeningSpent;

export const depositOpeningsLock = sql`select pg_advisory_xact_lock(hashtextextended('deposit-openings', 0))`;

export const depositOpeningRefusal = Effect.fn(
  "Directory.depositOpeningRefusal",
)(function* (executor: Executor, row: WalletRow, cap: number) {
  if (row.depositOpening === "recovered")
    return Option.some<DepositOpeningRefusal>(new DepositOpeningSpent());

  const now = yield* DateTime.now;

  const received = [
    executor
      .select({ wallet: deposits.wallet })
      .from(deposits)
      .where(eq(deposits.wallet, wallets.address)),
    executor
      .select({ destination: transfers.destination })
      .from(transfers)
      .where(
        and(
          eq(transfers.destination, wallets.address),
          eq(transfers.status, "settled"),
        ),
      ),
  ];

  const [empty] = yield* executor
    .select({ openings: count() })
    .from(wallets)
    .where(
      and(
        eq(wallets.network, network),
        eq(wallets.testnetEpoch, epochAt(DateTime.toEpochMillis(now))),
        eq(wallets.depositOpening, "attempted"),
        ne(wallets.address, row.address),
        or(
          eq(wallets.status, "active"),
          and(
            isNotNull(wallets.attemptHash),
            gt(wallets.attemptExpiresAt, DateTime.toDateUtc(now)),
          ),
        ),
        ...received.map((query) => not(exists(query))),
      ),
    );

  return (empty?.openings ?? 0) >= cap
    ? Option.some<DepositOpeningRefusal>(new DepositOpeningsFull())
    : Option.none();
});
