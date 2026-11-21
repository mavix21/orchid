import { Database } from "@workspace/db";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { AccountAddress, BalanceId, Profile, Username } from "../contract";
import { claimableReadLimit, epochAt, network } from "../stellar/network";
import { StoreFailure } from "./Directory.server";
import { transfers, usernames } from "./tables.server";
import {
  OpenBalance,
  OpenLinkRecord,
  OrderJson,
  RecipientJson,
} from "./transfer-records.server";

const unclaimedAt = (now: number) =>
  and(
    eq(transfers.network, network),
    eq(transfers.testnetEpoch, epochAt(now)),
    isNotNull(transfers.balanceId),
    isNull(transfers.balanceClosedAt),
  );

export const openBalancesFor = Effect.fn("Transfers.openBalances")(function* (
  address: AccountAddress,
) {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;

  const rows = yield* db
    .select({
      balance: transfers.balanceId,
      sender: transfers.sender,
      username: usernames.username,
      resolvedRecipient: transfers.resolvedRecipient,
    })
    .from(transfers)
    .innerJoin(usernames, eq(usernames.address, transfers.sender))
    .where(
      and(
        unclaimedAt(now),
        or(
          eq(transfers.claimableKind, "username"),
          isNull(transfers.claimableKind),
        ),
        eq(transfers.status, "settled"),
        or(eq(transfers.sender, address), eq(transfers.recipient, address)),
      ),
    )
    .orderBy(desc(transfers.createdAt))
    .limit(claimableReadLimit);

  return yield* Effect.try({
    try: () =>
      rows.flatMap((row) => {
        const to = Schema.decodeSync(RecipientJson)(row.resolvedRecipient);

        return to instanceof Profile
          ? [
              new OpenBalance({
                balance: Schema.decodeUnknownSync(BalanceId)(row.balance),
                from: new Profile({
                  address: Schema.decodeSync(AccountAddress)(row.sender),
                  username: Schema.decodeSync(Username)(row.username),
                }),
                to,
              }),
            ]
          : [];
      }),
    catch: (cause) => new StoreFailure({ cause }),
  });
});

export const openPaymentLinksFor = Effect.fn("Transfers.openPaymentLinks")(
  function* (sender: AccountAddress) {
    const db = yield* Database;
    const now = yield* Clock.currentTimeMillis;

    const rows = yield* db
      .select({
        balance: transfers.balanceId,
        order: transfers.order,
        createdAt: transfers.createdAt,
      })
      .from(transfers)
      .where(
        and(
          unclaimedAt(now),
          eq(transfers.sender, sender),
          eq(transfers.claimableKind, "paymentLink"),
          eq(transfers.status, "settled"),
        ),
      )
      .orderBy(desc(transfers.createdAt))
      .limit(claimableReadLimit);

    return yield* Effect.try({
      try: () =>
        rows.flatMap((row) => {
          const order = Schema.decodeSync(OrderJson)(row.order);

          return Predicate.isTagged(order.to, "PaymentLink") &&
            row.balance !== null
            ? [
                new OpenLinkRecord({
                  id: order.id,
                  balance: Schema.decodeSync(BalanceId)(row.balance),
                  address: order.to.value,
                  asset: order.asset,
                  amount: order.amount,
                  createdAt: DateTime.makeUnsafe(row.createdAt),
                }),
              ]
            : [];
        }),
      catch: (cause) => new StoreFailure({ cause }),
    });
  },
);
