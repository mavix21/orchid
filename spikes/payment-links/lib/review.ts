import { Asset, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import { toStroops } from "./network";
import { account } from "./state";

export const linkVerdict = async (link: string) => {
  const record = await account(link);

  if (record === undefined) return "absent";

  const reasons = [
    record.signers.length === 1 ? "" : "extra signers",
    record.signers[0]?.weight === 1 ? "" : "master weight is not one",
    record.thresholds.low_threshold === 0 &&
    record.thresholds.med_threshold === 0 &&
    record.thresholds.high_threshold === 0
      ? ""
      : "non-default thresholds",
    record.subentry_count === 0 ? "" : "subentries present",
    record.num_sponsoring === 0 && record.num_sponsored === 0
      ? ""
      : "sponsorship present",
    Object.values(record.flags).some((flag) => flag) ? "flags set" : "",
    record.home_domain === undefined ? "" : "home domain set",
    record.inflation_destination === undefined
      ? ""
      : "inflation destination set",
  ].filter((reason) => reason !== "");

  return reasons.length === 0 ? "clean" : `declined: ${reasons.join(", ")}`;
};

export interface Reviewed {
  readonly asset: Asset;
  readonly amount: string;
  readonly hasMemo: boolean;
}

const memoRequired = (data: { readonly [key: string]: string }) =>
  Buffer.from(data["config.memo_required"] ?? "", "base64").toString() === "1";

export const reviewDestination = async (
  destination: string,
  reviewed: Reviewed,
) => {
  const muxed = StrKey.isValidMed25519PublicKey(destination);

  const base = muxed
    ? MuxedAccount.fromAddress(destination, "0").baseAccount().accountId()
    : destination;

  const record = await account(base);

  if (record === undefined)
    return "refused: destination account does not exist";

  const reasons = [
    muxed && reviewed.hasMemo ? "memo conflicts with the muxed address" : "",
    memoRequired(record.data_attr) && !muxed && !reviewed.hasMemo
      ? "destination requires a memo (SEP-29)"
      : "",
    ...lineReasons(record, reviewed),
  ].filter((reason) => reason !== "");

  return reasons.length === 0 ? "accepted" : `refused: ${reasons.join(", ")}`;
};

const lineReasons = (
  record: NonNullable<Awaited<ReturnType<typeof account>>>,
  reviewed: Reviewed,
) => {
  if (reviewed.asset.isNative()) return [];

  const line = record.balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      balance.asset_type !== "liquidity_pool_shares" &&
      balance.asset_code === reviewed.asset.getCode() &&
      balance.asset_issuer === reviewed.asset.getIssuer(),
  );

  if (
    line === undefined ||
    line.asset_type === "native" ||
    line.asset_type === "liquidity_pool_shares"
  )
    return ["destination has no trustline"];

  const room =
    toStroops(line.limit) -
    toStroops(line.balance) -
    toStroops(line.buying_liabilities);

  return [
    line.is_authorized ? "" : "trustline is not authorized",
    room >= toStroops(reviewed.amount)
      ? ""
      : "trustline has insufficient capacity",
  ];
};
