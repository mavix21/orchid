import type { Database } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { AccountAddress } from "../contract";
import { epochAt, network } from "../stellar/network";
import { assetOrders, transfers } from "./tables.server";

type Executor = Pick<Database["Service"], "select">;

export const walletHasSignedWork = Effect.fn("Directory.walletHasSignedWork")(
  function* (executor: Executor, address: AccountAddress) {
    const epoch = epochAt(yield* Clock.currentTimeMillis);

    const [authorizedTransfers, authorizedOrders] = yield* Effect.all([
      executor
        .select({ id: transfers.id })
        .from(transfers)
        .where(
          and(
            eq(transfers.network, network),
            eq(transfers.testnetEpoch, epoch),
            eq(transfers.sender, address),
            eq(transfers.status, "authorized"),
          ),
        )
        .limit(1),
      executor
        .select({ id: assetOrders.id })
        .from(assetOrders)
        .where(
          and(
            eq(assetOrders.network, network),
            eq(assetOrders.testnetEpoch, epoch),
            eq(assetOrders.wallet, address),
            eq(assetOrders.status, "authorized"),
          ),
        )
        .limit(1),
    ]);

    return authorizedTransfers.length + authorizedOrders.length > 0;
  },
);
