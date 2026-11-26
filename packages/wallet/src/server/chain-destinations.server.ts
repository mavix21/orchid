import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  type AccountAddress,
  type Asset,
  type DestinationAddress,
  type IssuedAsset,
  type PositiveAmount,
  type RecipientCannotReceive,
  assetKey,
} from "../contract";
import { baseAccountOf, isMuxed } from "../stellar/destination";
import type { ChainUnreachable } from "./chain-errors.server";
import type { KnownExchangeMemo } from "./exchange-memos.server";
import type { Holdings } from "./ledger-assets.server";

export type MemoRule = Data.TaggedEnum<{
  MemoForbidden: {};
  MemoOptional: {};
  MemoRequired: {
    readonly account: AccountAddress;
    readonly exchange: string;
    readonly source: string;
  };
}>;

export const MemoRule = Data.taggedEnum<MemoRule>();

export type ReceiveBlocker = RecipientCannotReceive["reason"];

export interface DestinationChain {
  memoRule(
    destination: DestinationAddress,
  ): Effect.Effect<MemoRule, ChainUnreachable>;
  receiveBlocker(
    account: AccountAddress,
    asset: Asset,
    amount: PositiveAmount,
  ): Effect.Effect<Option.Option<ReceiveBlocker>, ChainUnreachable>;
}

const blockerFor = (
  holdings: Option.Option<Holdings>,
  asset: Asset,
  amount: PositiveAmount,
): Option.Option<ReceiveBlocker> => {
  if (Option.isNone(holdings)) return Option.some("no_account");

  if (!Predicate.isTagged(asset, "Issued")) return Option.none();

  const line = holdings.value.lines.find(
    (candidate) => assetKey(candidate.asset) === assetKey(asset),
  );

  if (line === undefined) return Option.some("no_trustline");

  if (!line.authorized) return Option.some("not_authorized");

  return line.capacity < amount ? Option.some("no_capacity") : Option.none();
};

export const destinationChain = (
  holdings: (
    address: AccountAddress,
    assets: ReadonlyArray<IssuedAsset>,
  ) => Effect.Effect<Option.Option<Holdings>, ChainUnreachable>,
  memoRequirement: (
    address: AccountAddress,
  ) => Effect.Effect<Option.Option<KnownExchangeMemo>, ChainUnreachable>,
): DestinationChain => ({
  memoRule: (destination) => {
    if (isMuxed(destination)) return Effect.succeed(MemoRule.MemoForbidden());

    const account = baseAccountOf(destination);

    return memoRequirement(account).pipe(
      Effect.map(
        Option.match({
          onNone: () => MemoRule.MemoOptional(),
          onSome: ({ exchange, source }) =>
            MemoRule.MemoRequired({ account, exchange, source }),
        }),
      ),
    );
  },
  receiveBlocker: (account, asset, amount) => {
    const issued = Predicate.isTagged(asset, "Issued") ? [asset] : [];

    return holdings(account, issued).pipe(
      Effect.map((found) => blockerFor(found, asset, amount)),
    );
  },
});
