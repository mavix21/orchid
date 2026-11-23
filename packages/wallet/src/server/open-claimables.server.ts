import { Database } from "@workspace/db";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  BalanceId,
  Profile,
  ReceivedPaymentLink,
  Username,
} from "../contract";
import { claimableReadLimit, epochAt, network } from "../stellar/network";
import { StoreFailure } from "./Directory.server";
import { AssetOrderJson } from "./AssetOrders.server";
import { assetOrders, transfers, usernames } from "./tables.server";
import {
  FundedLink,
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

export const fundedLinkAt = Effect.fn("Transfers.fundedLink")(function* (
  link: AccountAddress,
) {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;

  const rows = yield* db
    .select({
      balance: transfers.balanceId,
      order: transfers.order,
      sender: transfers.sender,
      username: usernames.username,
    })
    .from(transfers)
    .innerJoin(usernames, eq(usernames.address, transfers.sender))
    .where(
      and(
        eq(transfers.network, network),
        eq(transfers.testnetEpoch, epochAt(now)),
        eq(transfers.destination, link),
        eq(transfers.claimableKind, "paymentLink"),
        eq(transfers.status, "settled"),
        isNotNull(transfers.balanceId),
      ),
    )
    .orderBy(desc(transfers.createdAt))
    .limit(1);

  return yield* Effect.try({
    try: () =>
      Option.fromNullishOr(rows[0]).pipe(
        Option.flatMap((row) => {
          const order = Schema.decodeSync(OrderJson)(row.order);

          return Predicate.isTagged(order.to, "PaymentLink") &&
            order.to.value === link &&
            row.balance !== null
            ? Option.some(
                new FundedLink({
                  balance: Schema.decodeSync(BalanceId)(row.balance),
                  sender: new Profile({
                    address: Schema.decodeSync(AccountAddress)(row.sender),
                    username: Schema.decodeSync(Username)(row.username),
                  }),
                  asset: order.asset,
                  amount: order.amount,
                }),
              )
            : Option.none();
        }),
      ),
    catch: (cause) => new StoreFailure({ cause }),
  });
});

export const receivedPaymentLinksFor = Effect.fn(
  "Transfers.receivedPaymentLinks",
)(function* (sender: AccountAddress) {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;

  const rows = yield* db
    .select({
      order: transfers.order,
      receive: assetOrders.order,
      receivedAt: assetOrders.concludedAt,
    })
    .from(transfers)
    .innerJoin(
      assetOrders,
      and(
        eq(assetOrders.balanceId, transfers.balanceId),
        eq(assetOrders.network, transfers.network),
        eq(assetOrders.testnetEpoch, transfers.testnetEpoch),
        eq(assetOrders.status, "settled"),
      ),
    )
    .where(
      and(
        eq(transfers.network, network),
        eq(transfers.testnetEpoch, epochAt(now)),
        eq(transfers.sender, sender),
        eq(transfers.claimableKind, "paymentLink"),
        eq(transfers.status, "settled"),
        isNotNull(transfers.balanceClosedAt),
      ),
    )
    .orderBy(desc(assetOrders.concludedAt))
    .limit(claimableReadLimit);

  return yield* Effect.try({
    try: () =>
      rows.flatMap((row) => {
        const order = Schema.decodeSync(OrderJson)(row.order);
        const receive = Schema.decodeSync(AssetOrderJson)(row.receive);

        return Predicate.isTagged(order.to, "PaymentLink") &&
          Predicate.isTagged(receive.action, "ReceiveLink") &&
          receive.action.link === order.to.value &&
          row.receivedAt !== null
          ? [
              new ReceivedPaymentLink({
                id: order.id,
                address: order.to.value,
                asset: order.asset,
                amount: order.amount,
                receivedAt: DateTime.makeUnsafe(row.receivedAt),
              }),
            ]
          : [];
      }),
    catch: (cause) => new StoreFailure({ cause }),
  });
});
