import * as Effect from "effect/Effect";
import type { AccountAddress, HeldFundsId } from "../contract";
import { claimableQuota } from "../policy";
import { Chain, type ChainUnreachable } from "./Chain.server";
import type { StoreFailure } from "./Directory.server";
import { rpcReadConcurrency } from "./settings.server";
import { type ClaimableKind, Transfers } from "./Transfers.server";

export type QuotaCheck = (
  sender: AccountAddress,
  kind: ClaimableKind,
) => Effect.Effect<boolean, StoreFailure | ChainUnreachable>;

export const claimableQuotaFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const transfers = yield* Transfers;

  const closeGoneHeldFunds = (id: HeldFundsId) =>
    chain
      .heldFunds([id])
      .pipe(
        Effect.flatMap((confirmed) =>
          confirmed.length === 0 ? transfers.closeHeldFunds(id) : Effect.void,
        ),
      );

  const quotaReached = Effect.fn("Wallet.claimableQuotaReached")(function* (
    sender: AccountAddress,
    kind: ClaimableKind,
  ) {
    return (
      (yield* transfers.openClaimables(sender, kind)) >= claimableQuota[kind]
    );
  });

  const quotaFull = Effect.fn("Wallet.claimableQuotaFull")(function* (
    sender: AccountAddress,
    kind: ClaimableKind,
  ) {
    if (!(yield* quotaReached(sender, kind))) return false;

    yield* Effect.forEach(
      yield* transfers.settledOpenHeldFunds(sender, kind),
      closeGoneHeldFunds,
      { concurrency: rpcReadConcurrency, discard: true },
    );

    return yield* quotaReached(sender, kind);
  });

  return { closeGoneHeldFunds, quotaFull, quotaReached };
});
