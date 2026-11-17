import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  type AccountAddress,
  Amount,
  Balance,
  ClaimableBalance,
  NativeAsset,
  assetKey,
} from "../contract";
import { baseAsset } from "../contract";
import { AssetOrders } from "./AssetOrders.server";
import { Chain } from "./Chain.server";
import { opensAt } from "./ledger-assets.server";
import { Transfers } from "./Transfers.server";

export const portfolioFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const assets = yield* AssetOrders;
  const transfers = yield* Transfers;

  return Effect.fn("Wallet.portfolio")(function* (address: AccountAddress) {
    const tracked = yield* assets.tracked(address);
    const state = yield* chain.holdings(address, [baseAsset, ...tracked]);
    const balances: Balance[] = [];

    if (Option.isSome(state)) {
      for (const line of state.value.lines)
        balances.push(new Balance({ asset: line.asset, amount: line.balance }));

      if (state.value.account.nativeBalance > 0n)
        balances.push(
          new Balance({
            asset: NativeAsset.make({}),
            amount: Schema.decodeSync(Amount)(
              state.value.account.nativeBalance.toString(),
            ),
          }),
        );

      for (const asset of tracked) {
        if (
          !state.value.lines.some(
            (line) => assetKey(line.asset) === assetKey(asset),
          )
        ) {
          const confirmed = yield* chain.holdings(address, [asset]);

          if (Option.isSome(confirmed) && confirmed.value.lines.length === 0)
            yield* assets.forget(address, asset);
        }
      }
    }

    const pending = yield* transfers.openBalances(address);
    const entries = yield* chain.claimable(pending.map((item) => item.balance));
    const claimable: ClaimableBalance[] = [];

    for (const item of pending) {
      const entry = entries.find(
        (candidate) => candidate.balance === item.balance,
      );

      if (!entry) {
        const confirmed = yield* chain.claimable([item.balance]);

        if (confirmed.length === 0) yield* transfers.closeBalance(item.balance);

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

    return { balances, claimable };
  });
});
