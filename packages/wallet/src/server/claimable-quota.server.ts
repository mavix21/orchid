import * as Effect from "effect/Effect";
import type { AccountAddress, BalanceId } from "../contract";
import { claimableQuota } from "../stellar/network";
import { Chain } from "./Chain.server";
import { rpcReadConcurrency } from "./settings.server";
import { type ClaimableKind, Transfers } from "./Transfers.server";

export const claimableQuotaFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const transfers = yield* Transfers;

  const closeGoneBalance = (id: BalanceId) =>
    chain
      .claimable([id])
      .pipe(
        Effect.flatMap((confirmed) =>
          confirmed.length === 0 ? transfers.closeBalance(id) : Effect.void,
        ),
      );

  const quotaFull = Effect.fn("Wallet.claimableQuotaFull")(function* (
    sender: AccountAddress,
    kind: ClaimableKind,
  ) {
    const limit = claimableQuota[kind];

    if ((yield* transfers.openClaimables(sender, kind)) < limit) return false;

    yield* Effect.forEach(
      yield* transfers.settledOpenBalanceIds(sender, kind),
      closeGoneBalance,
      { concurrency: rpcReadConcurrency, discard: true },
    );

    return (yield* transfers.openClaimables(sender, kind)) >= limit;
  });

  return { closeGoneBalance, quotaFull };
});
