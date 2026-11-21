import {
  Asset,
  MuxedAccount,
  StrKey,
  type Horizon,
} from "@stellar/stellar-sdk";
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
  readonly link: string;
}

const memoRequired = (data: { readonly [key: string]: string }) =>
  Buffer.from(data["config.memo_required"] ?? "", "base64").toString() === "1";

const lineReasons = (
  record: Horizon.ServerApi.AccountRecord,
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

const baseOf = (destination: string) =>
  StrKey.isValidMed25519PublicKey(destination)
    ? MuxedAccount.fromAddress(destination, "0").baseAccount().accountId()
    : destination;

const readable = async (address: string) => {
  try {
    return { record: await account(address), failed: false };
  } catch {
    return { record: undefined, failed: true };
  }
};

export const reviewDestination = async (
  destination: string,
  reviewed: Reviewed,
) => {
  const stellar =
    StrKey.isValidEd25519PublicKey(destination) ||
    StrKey.isValidMed25519PublicKey(destination);

  if (!stellar) return "refused: not a Stellar address";

  const muxed = StrKey.isValidMed25519PublicKey(destination);
  const base = baseOf(destination);

  if (base === reviewed.link) return "refused: destination is the link account";

  if (!reviewed.asset.isNative() && base === reviewed.asset.getIssuer())
    return "refused: destination is the asset issuer";

  const { record, failed } = await readable(base);

  if (failed)
    return "refused: destination could not be verified, failing closed";

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

export const reviewLinkAsset = async (sender: string, asset: Asset) => {
  const issuerAddress = asset.getIssuer();

  if (asset.isNative() || issuerAddress === undefined) return "accepted";

  const issuer = await account(issuerAddress);
  const holder = await account(sender);

  const line = holder?.balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      balance.asset_type !== "liquidity_pool_shares" &&
      balance.asset_code === asset.getCode() &&
      balance.asset_issuer === asset.getIssuer(),
  );

  const clawback =
    line !== undefined &&
    line.asset_type !== "native" &&
    line.asset_type !== "liquidity_pool_shares" &&
    line.is_clawback_enabled;

  const reasons = [
    issuer?.flags.auth_required ? "issuer sets AUTH_REQUIRED" : "",
    clawback ? "sender trustline allows clawback" : "",
  ].filter((reason) => reason !== "");

  return reasons.length === 0 ? "accepted" : `refused: ${reasons.join(", ")}`;
};
