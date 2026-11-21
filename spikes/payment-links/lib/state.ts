import { Horizon, NotFoundError, type Asset } from "@stellar/stellar-sdk";
import { horizon, toStroops } from "./network";

export interface Snapshot {
  readonly address: string;
  readonly nativeBalance: bigint;
  readonly sequence: string;
  readonly subentries: number;
  readonly sponsoring: number;
  readonly sponsored: number;
  readonly signers: ReadonlyArray<string>;
  readonly thresholds: string;
  readonly flags: string;
  readonly lines: ReadonlyArray<string>;
}

export interface Line {
  readonly balance: string;
  readonly limit: string;
  readonly buyingLiabilities: string;
  readonly authorized: boolean;
}

const describeFlags = (flags: Horizon.HorizonApi.Flags) =>
  [
    flags.auth_required ? "AUTH_REQUIRED" : "",
    flags.auth_revocable ? "AUTH_REVOCABLE" : "",
    flags.auth_immutable ? "AUTH_IMMUTABLE" : "",
    flags.auth_clawback_enabled ? "CLAWBACK_ENABLED" : "",
  ]
    .filter((flag) => flag !== "")
    .join("+");

export const account = async (address: string) => {
  try {
    return await horizon.accounts().accountId(address).call();
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;

    throw error;
  }
};

export const snapshot = async (address: string) => {
  const record = await account(address);

  if (record === undefined) return undefined;

  const native = record.balances.find(
    (balance) => balance.asset_type === "native",
  );

  const snapshotted: Snapshot = {
    address,
    nativeBalance: native === undefined ? 0n : toStroops(native.balance),
    sequence: record.sequence,
    subentries: record.subentry_count,
    sponsoring: record.num_sponsoring,
    sponsored: record.num_sponsored,
    signers: record.signers.map((signer) => `${signer.key}:${signer.weight}`),
    thresholds: `${record.thresholds.low_threshold}/${record.thresholds.med_threshold}/${record.thresholds.high_threshold}`,
    flags: describeFlags(record.flags),
    lines: record.balances.flatMap((balance) =>
      balance.asset_type === "native"
        ? []
        : [`${balance.asset_type}:${balance.balance}`],
    ),
  };

  return snapshotted;
};

export const lineOf = async (address: string, asset: Asset) => {
  const record = await account(address);

  const found = record?.balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      balance.asset_type !== "liquidity_pool_shares" &&
      balance.asset_code === asset.getCode() &&
      balance.asset_issuer === asset.getIssuer(),
  );

  if (
    found === undefined ||
    found.asset_type === "native" ||
    found.asset_type === "liquidity_pool_shares"
  )
    return undefined;

  const line: Line = {
    balance: found.balance,
    limit: found.limit,
    buyingLiabilities: found.buying_liabilities,
    authorized: found.is_authorized,
  };

  return line;
};

export const counters = async (address: string) => {
  const state = await snapshot(address);

  return {
    sponsoring: state?.sponsoring ?? 0,
    sponsored: state?.sponsored ?? 0,
    subentries: state?.subentries ?? 0,
    nativeBalance:
      state === undefined ? "absent" : state.nativeBalance.toString(),
  };
};
