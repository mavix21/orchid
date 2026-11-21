import type {
  FeeBumpTransaction,
  Keypair,
  Transaction,
} from "@stellar/stellar-sdk";
import { horizon, rpcServer } from "./network";
import { account, counters, lineOf, snapshot } from "./state";
import { emit, type Notes } from "./report";
import { run, type World } from "./world";
import type { Asset } from "@stellar/stellar-sdk";

export const execute = async (
  proof: string,
  label: string,
  transaction: Transaction | FeeBumpTransaction,
  notes?: Notes,
) => {
  const outcome = await run(transaction);

  emit(proof, label, outcome, notes);

  return outcome;
};

export const sponsorCounters = async (
  proof: string,
  label: string,
  world: World,
) => {
  emit(proof, `${label}: sponsor reserve counters`, undefined, {
    ...(await counters(world.sponsor.publicKey())),
  });
};

export const accountFacts = async (
  proof: string,
  label: string,
  address: string,
) => {
  const state = await snapshot(address);

  emit(
    proof,
    `${label}: account state`,
    undefined,
    state === undefined
      ? { address, exists: false }
      : {
          address,
          exists: true,
          nativeBalanceStroops: state.nativeBalance.toString(),
          subentries: state.subentries,
          sponsoring: state.sponsoring,
          sponsored: state.sponsored,
          thresholds: state.thresholds,
          flags: state.flags,
          signers: state.signers.join(","),
          lines: state.lines.join(","),
        },
  );
};

export const lineFacts = async (
  proof: string,
  label: string,
  address: string,
  asset: Asset,
) => {
  const line = await lineOf(address, asset);

  emit(
    proof,
    `${label}: asset line`,
    undefined,
    line === undefined
      ? { address, line: "absent" }
      : {
          address,
          balance: line.balance,
          limit: line.limit,
          buyingLiabilities: line.buyingLiabilities,
          authorized: line.authorized,
        },
  );
};

export const memoFacts = async (proof: string, label: string, hash: string) => {
  const record = await horizon.transactions().transaction(hash).call();

  emit(proof, `${label}: memo on ledger`, undefined, {
    memoType: record.memo_type,
    memo: record.memo ?? "none",
    sourceAccount: record.source_account,
    feeAccount: record.fee_account,
  });
};

export const balanceExists = async (balanceId: string) => {
  const found = await horizon
    .claimableBalances()
    .claimableBalance(balanceId)
    .call()
    .then(
      (record) => record,
      () => undefined,
    );

  return found !== undefined;
};

export const exists = async (address: string) =>
  (await account(address)) !== undefined;

export const protocol = async (proof: string) => {
  const latest = await rpcServer.getLatestLedger();

  emit(proof, "network", undefined, {
    protocolVersion: latest.protocolVersion,
    latestLedger: latest.sequence,
  });
};

export const envelopeFacts = (
  proof: string,
  label: string,
  transaction: FeeBumpTransaction,
  roles: ReadonlyMap<string, string>,
) => {
  const inner = transaction.innerTransaction;

  const named = (address: string | undefined) =>
    address === undefined ? "tx-source" : (roles.get(address) ?? address);

  emit(proof, `${label}: envelope`, undefined, {
    innerSource: named(inner.source),
    feeSource: named(transaction.feeSource),
    operations: inner.operations
      .map(
        (operation, index) =>
          `${index + 1}:${operation.type}@${named(operation.source)}`,
      )
      .join(" "),
    innerSignatures: inner.signatures.length,
    outerSignatures: transaction.signatures.length,
    innerFeeStroops: inner.fee,
    outerFeeStroops: transaction.fee,
    envelopeXdr: transaction.toEnvelope().toXDR("base64"),
  });
};

export const roleMap = (
  world: World,
  extra: ReadonlyArray<readonly [string, Keypair]> = [],
) =>
  new Map<string, string>([
    [world.sponsor.publicKey(), "sponsor"],
    [world.feePayer.publicKey(), "feePayer"],
    [world.rosa.publicKey(), "rosa"],
    ...world.channels.map((channel, index): readonly [string, string] => [
      channel.publicKey(),
      `channel${index}`,
    ]),
    ...extra.map(([name, keypair]): readonly [string, string] => [
      keypair.publicKey(),
      name,
    ]),
  ]);

export const sequenceOf = async (address: string) =>
  (await account(address))?.sequence ?? "absent";
