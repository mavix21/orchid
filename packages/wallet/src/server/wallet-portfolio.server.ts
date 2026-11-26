import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import {
  type AccountAddress,
  type HeldFundsId,
  Balance,
  HeldFunds,
  baseAsset,
  nativeAsset,
  sameAsset,
} from "../contract";
import { AssetOrders } from "./AssetOrders.server";
import { Chain } from "./Chain.server";
import { opensAt } from "./ledger-assets.server";
import { rpcReadConcurrency } from "./settings.server";
import { Transfers } from "./Transfers.server";

export const portfolioFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const assets = yield* AssetOrders;
  const transfers = yield* Transfers;

  const loadHoldings = (
    address: AccountAddress,
    permits: Semaphore.Semaphore,
  ) =>
    Effect.gen(function* () {
      const tracked = yield* assets.tracked(address);

      const state = yield* permits.withPermit(
        chain.holdings(address, [baseAsset, ...tracked]),
      );

      const balances: Balance[] = [];

      if (Option.isSome(state)) {
        for (const line of state.value.lines)
          balances.push(
            new Balance({ asset: line.asset, amount: line.balance }),
          );

        if (state.value.nativeTotal > 0n)
          balances.push(
            new Balance({
              asset: nativeAsset,
              amount: state.value.nativeTotal,
            }),
          );

        const missing = tracked.filter(
          (asset) =>
            !state.value.lines.some((line) => sameAsset(line.asset, asset)),
        );

        yield* Effect.forEach(
          missing,
          (asset) =>
            permits
              .withPermit(chain.holdings(address, [asset]))
              .pipe(
                Effect.flatMap((confirmed) =>
                  Option.isSome(confirmed) && confirmed.value.lines.length === 0
                    ? assets.forget(address, asset)
                    : Effect.void,
                ),
              ),
          { concurrency: rpcReadConcurrency, discard: true },
        );
      }

      return {
        reserveSponsor: Option.flatMap(
          state,
          (holdings) => holdings.reserveSponsor,
        ),
        balances,
      };
    });

  const loadHeldFunds = (
    address: AccountAddress,
    permits: Semaphore.Semaphore,
  ) =>
    Effect.gen(function* () {
      const pending = yield* transfers.openHeldFunds(address);

      const entries = yield* permits.withPermit(
        chain.heldFunds(pending.map((item) => item.id)),
      );

      const waiting: HeldFunds[] = [];
      const missing: HeldFundsId[] = [];

      for (const item of pending) {
        const entry = entries.find(
          (candidate) => candidate.heldFunds === item.id,
        );

        if (!entry) {
          missing.push(item.id);
          continue;
        }

        const claimant = entry.claimants.find(
          (candidate) => candidate.destination === address,
        );

        waiting.push(
          new HeldFunds({
            ...item,
            asset: entry.asset,
            amount: entry.amount,
            claimableAt: claimant
              ? Option.map(opensAt(claimant.predicate), (at) =>
                  DateTime.makeUnsafe(Number(at) * 1000),
                )
              : Option.none(),
          }),
        );
      }

      yield* Effect.forEach(
        missing,
        (id) =>
          permits
            .withPermit(chain.heldFunds([id]))
            .pipe(
              Effect.flatMap((confirmed) =>
                confirmed.length === 0
                  ? transfers.closeHeldFunds(id)
                  : Effect.void,
              ),
            ),
        { concurrency: rpcReadConcurrency, discard: true },
      );

      return waiting;
    });

  const portfolio = Effect.fn("Wallet.portfolio")(function* (
    address: AccountAddress,
  ) {
    const permits = yield* Semaphore.make(rpcReadConcurrency);

    const [holdings, heldFunds] = yield* Effect.all(
      [loadHoldings(address, permits), loadHeldFunds(address, permits)],
      { concurrency: rpcReadConcurrency },
    );

    return {
      ...holdings,
      heldFunds,
    };
  });

  const heldFundsFor = Effect.fn("Wallet.heldFundsFor")(function* (
    address: AccountAddress,
  ) {
    const permits = yield* Semaphore.make(rpcReadConcurrency);

    return yield* loadHeldFunds(address, permits);
  });

  return { portfolio, heldFundsFor };
});
