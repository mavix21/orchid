import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress } from "./identity";

// --- assets -------------------------------------------------------------

/** 1 to 12 of a–z A–Z 0–9: the alphanumeric 4 and alphanumeric 12 code forms. */
export const AssetCode = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9]{1,12}$/),
).pipe(Schema.brand("AssetCode"));

export type AssetCode = typeof AssetCode.Type;

/** XLM. It needs no trustline. */
export const NativeAsset = Schema.TaggedStruct("Native", {});

export type NativeAsset = typeof NativeAsset.Type;

/** A code and the account that issues it. Holding one needs a trustline. */
export const IssuedAsset = Schema.TaggedStruct("Issued", {
  code: AssetCode,
  issuer: AccountAddress,
});

export type IssuedAsset = typeof IssuedAsset.Type;

export const Asset = Schema.Union([NativeAsset, IssuedAsset]);

export type Asset = typeof Asset.Type;

/** "native" or "CODE:ISSUER"; equal exactly when the assets are the same. */
export function assetKey(asset: Asset): string {
  return Match.valueTags(asset, {
    Native: () => "native",
    Issued: ({ code, issuer }) => `${code}:${issuer}`,
  });
}

// --- money --------------------------------------------------------------

/**
 * An amount of any Stellar asset in base units: 1 unit = 10_000_000, the
 * network's fixed seven decimal places. A bigint in memory, digits on the wire.
 */
export const Amount = Schema.BigIntFromString.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: 9223372036854775807n }),
).pipe(Schema.brand("Amount"));

export type Amount = typeof Amount.Type;

export const PositiveAmount = Amount.check(Schema.isGreaterThanBigInt(0n)).pipe(
  Schema.brand("PositiveAmount"),
);

export type PositiveAmount = typeof PositiveAmount.Type;

/** "5", "5.5", "5.50" → base units. None when it is not a positive amount with ≤ 7 decimals. */
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

/** A claimable balance ID in the SDK's 72-character hex form. */
export const BalanceId = Schema.String.check(
  Schema.isPattern(/^00000000[0-9a-f]{64}$/),
).pipe(Schema.brand("BalanceId"));

export type BalanceId = typeof BalanceId.Type;
