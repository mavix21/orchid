import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress } from "./identity";

export const AssetCode = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9]{1,12}$/),
).pipe(Schema.brand("AssetCode"));

export type AssetCode = typeof AssetCode.Type;

export const NativeAsset = Schema.TaggedStruct("Native", {});

export type NativeAsset = typeof NativeAsset.Type;

export const IssuedAsset = Schema.TaggedStruct("Issued", {
  code: AssetCode,
  issuer: AccountAddress,
});

export type IssuedAsset = typeof IssuedAsset.Type;

export const Asset = Schema.Union([NativeAsset, IssuedAsset]);

export type Asset = typeof Asset.Type;

export function assetKey(asset: Asset): string {
  return Match.valueTags(asset, {
    Native: () => "native",
    Issued: ({ code, issuer }) => `${code}:${issuer}`,
  });
}

export const Amount = Schema.BigIntFromString.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: 9223372036854775807n }),
).pipe(Schema.brand("Amount"));

export type Amount = typeof Amount.Type;

export const PositiveAmount = Amount.check(Schema.isGreaterThanBigInt(0n)).pipe(
  Schema.brand("PositiveAmount"),
);

export type PositiveAmount = typeof PositiveAmount.Type;

export function parseAmount(text: string): Option.Option<PositiveAmount> {
  if (!/^[0-9]+(?:\.[0-9]{1,7})?$/.test(text) || text.length > 32)
    return Option.none();

  const [whole = "0", fraction = ""] = text.split(".");

  return Schema.decodeOption(PositiveAmount)(
    (BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, "0"))).toString(),
  );
}

export function formatAmount(amount: Amount): string {
  const fraction = (amount % 10000000n)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");

  return `${amount / 10000000n}${fraction ? `.${fraction}` : ""}`;
}

export const BalanceId = Schema.String.check(
  Schema.isPattern(/^00000000[0-9a-f]{64}$/),
).pipe(Schema.brand("BalanceId"));

export type BalanceId = typeof BalanceId.Type;
