import {
  Account,
  Asset,
  Claimant,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { baseFee, horizon, passphrase, rpcServer } from "./network";
import { run } from "./world";

export interface Receipt {
  readonly network: string;
  readonly balanceId: string;
}

export const keyOf = (balanceId: string) =>
  xdr.LedgerKey.claimableBalance(
    new xdr.LedgerKeyClaimableBalance({
      balanceId: xdr.ClaimableBalanceId.fromXdr(balanceId, "hex"),
    }),
  );

export const readByReceipt = async (receipt: Receipt) => {
  const response = await rpcServer.getLedgerEntries(keyOf(receipt.balanceId));

  const entry = response.entries[0];

  if (entry === undefined || entry.val.type !== "claimableBalance")
    return "absent";

  const balance = entry.val.value;

  return `present: amount=${balance.amount} claimants=${balance.claimants.length}`;
};

const placeholder = (sender: string) =>
  Operation.createClaimableBalance({
    asset: Asset.native(),
    amount: "1",
    claimants: [new Claimant(sender)],
  });

export const candidateBalanceId = (sender: string, sequence: bigint) => {
  const draft = new TransactionBuilder(
    new Account(sender, (sequence - 1n).toString()),
    {
      fee: baseFee,
      networkPassphrase: passphrase,
    },
  )
    .addOperation(placeholder(sender))
    .addOperation(placeholder(sender))
    .setTimeout(60)
    .build();

  return draft.getClaimableBalanceId(1);
};

const batchSize = 200;

export interface Scan {
  readonly requests: number;
  readonly found: ReadonlyArray<string>;
}

export const scanSequences = async (
  sender: string,
  from: bigint,
  to: bigint,
): Promise<Scan> => {
  const sequences = Array.from(
    { length: Number(to - from + 1n) },
    (_, offset) => from + BigInt(offset),
  );

  const batches = Array.from(
    { length: Math.ceil(sequences.length / batchSize) },
    (_, index) => sequences.slice(index * batchSize, (index + 1) * batchSize),
  );

  const results = await Promise.all(
    batches.map(async (batch) => {
      const ids = batch.map((sequence) => candidateBalanceId(sender, sequence));
      const response = await rpcServer.getLedgerEntries(...ids.map(keyOf));

      return response.entries.flatMap((entry) =>
        entry.val.type === "claimableBalance"
          ? [entry.val.value.balanceId.toXDR("hex")]
          : [],
      );
    }),
  );

  return { requests: batches.length, found: results.flat() };
};

export interface Listed {
  readonly id: string;
  readonly claimants: number;
  readonly sponsor: string;
  readonly asset: string;
  readonly amount: string;
}

export const listForSender = async (sender: string) => {
  const page = await horizon
    .claimableBalances()
    .claimant(sender)
    .limit(200)
    .call();

  return page.records.map((record): Listed => ({
    id: record.id,
    claimants: record.claimants.length,
    sponsor: record.sponsor ?? "none",
    asset: record.asset,
    amount: record.amount,
  }));
};

export const reclaimAlone = async (sender: Keypair, balanceId: string) => {
  const record = await horizon.loadAccount(sender.publicKey());

  const transaction = new TransactionBuilder(record, {
    fee: baseFee,
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(60)
    .build();

  transaction.sign(sender);

  return run(transaction);
};
