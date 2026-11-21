import {
  FeeBumpTransaction,
  Transaction,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { pause, rpcServer } from "./network";

export interface Outcome {
  readonly hash: string;
  readonly status: "SUCCESS" | "FAILED" | "REJECTED";
  readonly ledger: number | undefined;
  readonly feeCharged: string | undefined;
  readonly result: string;
  readonly operations: ReadonlyArray<string>;
}

const operationCodes = (results: ReadonlyArray<xdr.OperationResult>) =>
  results.map((result) =>
    result.type === "opInner" ? result.tr.value.type : result.type,
  );

const describeResult = (result: xdr.TransactionResult) => {
  const outcome = result.result;

  if (
    outcome.type === "txFeeBumpInnerSuccess" ||
    outcome.type === "txFeeBumpInnerFailed"
  ) {
    const inner = outcome.innerResultPair.result.result;

    return {
      result: `${outcome.type}/${inner.type}`,
      operations:
        inner.type === "txSuccess" || inner.type === "txFailed"
          ? operationCodes(inner.results)
          : [],
    };
  }

  return {
    result: outcome.type,
    operations:
      outcome.type === "txSuccess" || outcome.type === "txFailed"
        ? operationCodes(outcome.results)
        : [],
  };
};

const confirmed = async (hash: string, attemptsLeft: number) => {
  const response = await rpcServer.getTransaction(hash);

  if (
    response.status !== rpc.Api.GetTransactionStatus.NOT_FOUND ||
    attemptsLeft === 0
  )
    return response;

  await pause(1_500);

  return confirmed(hash, attemptsLeft - 1);
};

export const submit = async (
  transaction: Transaction | FeeBumpTransaction,
): Promise<Outcome> => {
  const hash = Buffer.from(transaction.hash()).toString("hex");
  const sent = await rpcServer.sendTransaction(transaction);

  if (sent.status === "ERROR" && sent.errorResult !== undefined) {
    const described = describeResult(sent.errorResult);

    return {
      hash,
      status: "REJECTED",
      ledger: undefined,
      feeCharged: undefined,
      ...described,
    };
  }

  if (sent.status === "TRY_AGAIN_LATER") {
    await pause(3_000);

    return submit(transaction);
  }

  const response = await confirmed(hash, 40);

  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND)
    throw new Error(`Transaction ${hash} was not confirmed in time`);

  return {
    hash,
    status: response.status,
    ledger: response.ledger,
    feeCharged: response.resultXdr.feeCharged.toString(),
    ...describeResult(response.resultXdr),
  };
};
