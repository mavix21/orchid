import type { Account } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import {
  type AccountAddress,
  type Asset,
  type BalanceId,
  type IssuedAsset,
  type PositiveAmount,
  SigningRequest,
} from "../contract";
import { draftClaimable } from "../stellar/asset-envelopes";
import { type AssetPlan, draftPlan } from "../stellar/asset-plans";
import { toStellarAsset } from "../stellar/assets";
import { paymentLifetime, usdc } from "../stellar/network";
import { ChainUnreachable } from "./chain-errors.server";
import {
  type ClaimableEntry,
  type Holdings,
  type Issuer,
  accountKey,
  balanceKey,
  claimablesFromEntries,
  holdingsFromEntries,
  issuerFromEntries,
  lineKey,
} from "./ledger-assets.server";
import { fetchEntries } from "./ledger.server";

export interface AssetChain {
  holdings(
    address: AccountAddress,
    assets: ReadonlyArray<IssuedAsset>,
  ): Effect.Effect<Option.Option<Holdings>, ChainUnreachable>;
  issuer(
    asset: IssuedAsset,
  ): Effect.Effect<Option.Option<Issuer>, ChainUnreachable>;

  claimable(
    balances: ReadonlyArray<BalanceId>,
  ): Effect.Effect<ReadonlyArray<ClaimableEntry>, ChainUnreachable>;
  draftClaimable(
    from: AccountAddress,
    to: AccountAddress,
    asset: Asset,
    amount: PositiveAmount,
  ): Effect.Effect<SigningRequest, ChainUnreachable>;
  draftAsset(
    address: AccountAddress,
    plan: AssetPlan,
  ): Effect.Effect<SigningRequest, ChainUnreachable>;
}

export function assetChain(
  rpcUrl: string,
  reserveSponsor: AccountAddress,
  source: (address: AccountAddress) => Effect.Effect<Account, ChainUnreachable>,
): AssetChain {
  const read = <A>(
    keys: Parameters<typeof fetchEntries>[1],
    decode: (result: Effect.Success<ReturnType<typeof fetchEntries>>) => A,
  ) => fetchEntries(rpcUrl, keys).pipe(Effect.map(decode));

  const window = () => {
    const minTime = Math.floor(Date.now() / 1000);
    const maxTime = minTime + paymentLifetime;

    return {
      minTime,
      maxTime,
      expiresAt: DateTime.makeUnsafe(maxTime * 1000),
    };
  };

  return {
    holdings: (address, assets) =>
      read(
        [
          accountKey(address),
          lineKey(address, usdc),
          ...assets.map((asset) => lineKey(address, toStellarAsset(asset))),
        ],
        (result) =>
          holdingsFromEntries(
            result.entries ?? [],
            result.latestLedger,
            reserveSponsor,
            address,
            assets,
          ),
      ),
    issuer: (asset) =>
      read([accountKey(asset.issuer)], (result) =>
        issuerFromEntries(result.entries ?? [], asset.issuer),
      ),
    claimable: (balances) =>
      balances.length === 0
        ? Effect.succeed([])
        : read(balances.map(balanceKey), (result) =>
            claimablesFromEntries(result.entries ?? [], reserveSponsor),
          ),
    draftClaimable: Effect.fn("Chain.draftClaimable")(function* (
      from: AccountAddress,
      to: AccountAddress,
      asset: Asset,
      amount: PositiveAmount,
    ) {
      const holder = yield* source(from);
      const { expiresAt, ...bounds } = window();

      return new SigningRequest({
        envelope: draftClaimable({
          ...bounds,
          source: holder,
          reserveSponsor,
          to,
          asset,
          amount,
        }),
        expiresAt,
      });
    }),
    draftAsset: Effect.fn("Chain.draftAsset")(function* (
      address: AccountAddress,
      plan: AssetPlan,
    ) {
      const holder = yield* source(address);
      const { expiresAt, ...bounds } = window();

      return new SigningRequest({
        envelope: draftPlan(plan, {
          ...bounds,
          source: holder,
          reserveSponsor,
        }),
        expiresAt,
      });
    }),
  };
}
