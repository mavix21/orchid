import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import {
  type AccountAddress,
  type BalanceId,
  Balance,
  ClaimableBalance,
  NativeAsset,
  assetKey,
  baseAsset,
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
              asset: NativeAsset.make({}),
              amount: state.value.nativeTotal,
            }),
          );

        const missing = tracked.filter(
          (asset) =>
            !state.value.lines.some(
              (line) => assetKey(line.asset) === assetKey(asset),
            ),
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

  const loadClaimables = (
    address: AccountAddress,
    permits: Semaphore.Semaphore,
  ) =>
    Effect.gen(function* () {
      const pending = yield* transfers.openBalances(address);

      const entries = yield* permits.withPermit(
        chain.claimable(pending.map((item) => item.balance)),
      );

      const claimable: ClaimableBalance[] = [];
      const missing: BalanceId[] = [];

      for (const item of pending) {
        const entry = entries.find(
          (candidate) => candidate.balance === item.balance,
        );

        if (!entry) {
          missing.push(item.balance);
          continue;
        }

        const claimant = entry.claimants.find(
          (candidate) => candidate.destination === address,
        );

        claimable.push(
          new ClaimableBalance({
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
        (balance) =>
          permits
            .withPermit(chain.claimable([balance]))
            .pipe(
              Effect.flatMap((confirmed) =>
                confirmed.length === 0
                  ? transfers.closeBalance(balance)
                  : Effect.void,
              ),
            ),
        { concurrency: rpcReadConcurrency, discard: true },
      );

      return claimable;
    });

  const portfolio = Effect.fn("Wallet.portfolio")(function* (
    address: AccountAddress,
  ) {
    const permits = yield* Semaphore.make(rpcReadConcurrency);

    const [holdings, claimable] = yield* Effect.all(
      [loadHoldings(address, permits), loadClaimables(address, permits)],
      { concurrency: rpcReadConcurrency },
    );

    return {
      ...holdings,
      claimable,
    };
  });

  const claimablesFor = Effect.fn("Wallet.claimablesFor")(function* (
    address: AccountAddress,
  ) {
    const permits = yield* Semaphore.make(rpcReadConcurrency);

    return yield* loadClaimables(address, permits);
  });

  return { portfolio, claimablesFor };
});
