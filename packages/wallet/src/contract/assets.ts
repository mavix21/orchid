import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress } from "./identity";

export const AssetCode = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9]{1,12}$/u),
).pipe(Schema.brand("AssetCode"));

export type AssetCode = typeof AssetCode.Type;

export const NativeAsset = Schema.TaggedStruct("Native", {});

export type NativeAsset = typeof NativeAsset.Type;

export const IssuedAsset = Schema.TaggedStruct("Issued", {
  code: AssetCode,
  issuer: AccountAddress,
});

export type IssuedAsset = typeof IssuedAsset.Type;

export const baseAsset = IssuedAsset.make({
  code: Schema.decodeSync(AssetCode)("USDC"),
  issuer: Schema.decodeSync(AccountAddress)(
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  ),
});

export const Asset = Schema.Union([NativeAsset, IssuedAsset]);

export type Asset = typeof Asset.Type;

export function assetKey(asset: Asset): string {
  return Match.valueTags(asset, {
    Native: () => "native",
    Issued: ({ code, issuer }) => `${code}:${issuer}`,
  });
}

export interface AssetPrecision {
  readonly decimals: number;
  readonly maximum: bigint;
}

const sevenDecimals: AssetPrecision = {
  decimals: 7,
  maximum: 9223372036854775807n,
};

export function precisionOf(asset: Asset): AssetPrecision {
  return Match.valueTags(asset, {
    Native: () => sevenDecimals,
    Issued: () => sevenDecimals,
  });
}

export const Amount = Schema.BigIntFromString.check(
  Schema.isGreaterThanOrEqualToBigInt(0n),
).pipe(Schema.brand("Amount"));

export type Amount = typeof Amount.Type;

export const PositiveAmount = Amount.check(Schema.isGreaterThanBigInt(0n)).pipe(
  Schema.brand("PositiveAmount"),
);

export type PositiveAmount = typeof PositiveAmount.Type;

export const withinAssetMaximum = Schema.makeFilter(
  ({
    asset,
    amount,
  }: {
    readonly asset: Asset;
    readonly amount: PositiveAmount;
  }) => amount <= precisionOf(asset).maximum,
);

const unitsPerWhole = ({ decimals }: AssetPrecision) => 10n ** BigInt(decimals);

export function parseAmount(
  text: string,
  precision: AssetPrecision,
): Option.Option<PositiveAmount> {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text) || text.length > 32)
    return Option.none();

  const [whole = "0", fraction = ""] = text.split(".");

  if (fraction.length > precision.decimals) return Option.none();

  const units =
    BigInt(whole) * unitsPerWhole(precision) +
    BigInt(fraction.padEnd(precision.decimals, "0"));

  if (units > precision.maximum) return Option.none();

  return Schema.decodeOption(PositiveAmount)(units.toString());
}

export function formatAmount(
  amount: Amount,
  precision: AssetPrecision,
): string {
  const scale = unitsPerWhole(precision);

  const fraction = (amount % scale)
    .toString()
    .padStart(precision.decimals, "0")
    .replace(/0+$/, "");

  return `${amount / scale}${fraction ? `.${fraction}` : ""}`;
}

export const BalanceId = Schema.String.check(
  Schema.isPattern(/^00000000[0-9a-f]{64}$/u),
).pipe(Schema.brand("BalanceId"));

export type BalanceId = typeof BalanceId.Type;
