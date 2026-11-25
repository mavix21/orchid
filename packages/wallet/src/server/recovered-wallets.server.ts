import { Database } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { network } from "../stellar/network";
import type { WalletRow } from "./Directory.server";
import { wallets } from "./tables.server";

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
    })
    .where(
      and(
        eq(wallets.network, network),
        eq(wallets.address, row.address),
        eq(wallets.version, row.version),
      ),
    );
});
