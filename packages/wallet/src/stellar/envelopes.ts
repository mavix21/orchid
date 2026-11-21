import {
  Account,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Asset,
  DestinationAddress,
  PaymentMemo,
  PositiveAmount,
  UnsignedEnvelope,
  formatAmount,
  parseAmount,
} from "../contract";
import { type AssetFacts, readAssetEnvelope } from "./asset-envelopes";
import { fromStellarAsset, toStellarAsset } from "./assets";
import { bounds } from "./bounds";
import { baseFee, networkPassphrase, usdc } from "./network";

export type EnvelopeFacts =
  | OpeningFacts
  | PaymentFacts
  | RecoveryFacts
  | AssetFacts;

export class OpeningFacts extends Schema.TaggedClass<OpeningFacts>()(
  "OpeningFacts",
  {
    ...bounds,
    address: AccountAddress,
    reserveSponsor: AccountAddress,
    createAccount: Schema.Boolean,
  },
) {}

export class PaymentFacts extends Schema.TaggedClass<PaymentFacts>()(
  "PaymentFacts",
  {
    ...bounds,
    from: AccountAddress,
    to: DestinationAddress,
    asset: Asset,
    amount: PositiveAmount,
    memo: Schema.optional(PaymentMemo),
  },
) {}

export class RecoveryFacts extends Schema.TaggedClass<RecoveryFacts>()(
  "RecoveryFacts",
  {
    ...bounds,
    address: AccountAddress,
    reserveSponsor: AccountAddress,
  },
) {}

export interface OpeningInput {
  readonly source: Account;
  readonly address: AccountAddress;
  readonly minTime: number;
  readonly maxTime: number;
  readonly createAccount: boolean;
}

export interface PaymentInput {
  readonly source: Account;
  readonly to: DestinationAddress;
  readonly asset: Asset;
  readonly amount: PositiveAmount;
  readonly memo?: PaymentMemo;
  readonly minTime: number;
  readonly maxTime: number;
}

export interface RecoveryInput {
  readonly source: Account;
  readonly reserveSponsor: AccountAddress;
  readonly minTime: number;
  readonly maxTime: number;
}

export function draftOpening(input: OpeningInput): UnsignedEnvelope {
  const builder = new TransactionBuilder(input.source, {
    fee: baseFee,
    networkPassphrase,
  }).addOperation(
    Operation.beginSponsoringFutureReserves({ sponsoredId: input.address }),
  );

  if (input.createAccount)
    builder.addOperation(
      Operation.createAccount({
        destination: input.address,
        startingBalance: "0",
      }),
    );

  return Schema.decodeSync(UnsignedEnvelope)(
    builder
      .addOperation(
        Operation.changeTrust({ source: input.address, asset: usdc }),
      )
      .addOperation(
        Operation.endSponsoringFutureReserves({ source: input.address }),
      )
      .setTimebounds(input.minTime, input.maxTime)
      .build()
      .toXDR(),
  );
}

export function draftPayment(input: PaymentInput): UnsignedEnvelope {
  return Schema.decodeSync(UnsignedEnvelope)(
    new TransactionBuilder(input.source, {
      fee: baseFee,
      networkPassphrase,
      memo:
        input.memo?.type === "text"
          ? Memo.text(input.memo.value)
          : input.memo
            ? Memo.id(input.memo.value)
            : Memo.none(),
    })
      .addOperation(
        Operation.payment({
          destination: input.to,
          asset: toStellarAsset(input.asset),
          amount: formatAmount(input.amount),
        }),
      )
      .setTimebounds(input.minTime, input.maxTime)
      .build()
      .toXDR(),
  );
}

export function draftRecovery(input: RecoveryInput): UnsignedEnvelope {
  return Schema.decodeSync(UnsignedEnvelope)(
    new TransactionBuilder(input.source, { fee: baseFee, networkPassphrase })
      .addOperation(Operation.changeTrust({ asset: usdc, limit: "0" }))
      .addOperation(
        Operation.accountMerge({ destination: input.reserveSponsor }),
      )
      .setTimebounds(input.minTime, input.maxTime)
      .build()
      .toXDR(),
  );
}

export function readEnvelope(
  envelope: UnsignedEnvelope,
): Option.Option<EnvelopeFacts> {
  try {
    const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase);

    if (
      !(tx instanceof Transaction) ||
      tx.signatures.length !== 0 ||
      !tx.timeBounds
    )
      return Option.none();

    const minTime = Number(tx.timeBounds.minTime);
    const maxTime = Number(tx.timeBounds.maxTime);

    const source = () =>
      new Account(tx.source, (BigInt(tx.sequence) - 1n).toString());

    const fields = { sequence: tx.sequence, minTime, maxTime };
    const [first, second] = tx.operations;

    if (
      !Number.isSafeInteger(minTime) ||
      !Number.isSafeInteger(maxTime) ||
      minTime < 0 ||
      maxTime <= minTime ||
      BigInt(tx.sequence) <= 0n
    )
      return Option.none();

    if (first?.type === "beginSponsoringFutureReserves") {
      const address = Schema.decodeSync(AccountAddress)(first.sponsoredId);
      const reserveSponsor = Schema.decodeSync(AccountAddress)(tx.source);
      const createAccount = second?.type === "createAccount";

      if (
        draftOpening({
          source: source(),
          address,
          minTime,
          maxTime,
          createAccount,
        }) === envelope
      )
        return Option.some(
          new OpeningFacts({
            ...fields,
            address,
            reserveSponsor,
            createAccount,
          }),
        );
    }

    if (first?.type === "payment") {
      const memo = tx.memo;
      const value = memo.value;

      const reference =
        memo.type === "none"
          ? undefined
          : Schema.decodeUnknownSync(PaymentMemo)({
              type: memo.type,
              value:
                value instanceof Uint8Array
                  ? new TextDecoder("utf-8", {
                      fatal: true,
                      ignoreBOM: true,
                    }).decode(value)
                  : value,
            });

      const payment = reference ? { memo: reference } : {};
      const amount = parseAmount(first.amount);
      const asset = fromStellarAsset(first.asset);
      const from = Schema.decodeSync(AccountAddress)(tx.source);
      const to = Schema.decodeSync(DestinationAddress)(first.destination);

      if (
        Option.isSome(amount) &&
        draftPayment({
          source: source(),
          to,
          asset,
          amount: amount.value,
          minTime,
          maxTime,
          ...payment,
        }) === envelope
      )
        return Option.some(
          new PaymentFacts({
            ...fields,
            from,
            to,
            asset,
            amount: amount.value,
            ...payment,
          }),
        );
    }

    if (first?.type === "changeTrust" && second?.type === "accountMerge") {
      const address = Schema.decodeSync(AccountAddress)(tx.source);

      const reserveSponsor = Schema.decodeSync(AccountAddress)(
        second.destination,
      );

      if (
        minTime > 0 &&
        draftRecovery({
          source: source(),
          reserveSponsor,
          minTime,
          maxTime,
        }) === envelope
      )
        return Option.some(
          new RecoveryFacts({ ...fields, address, reserveSponsor }),
        );
    }

    return readAssetEnvelope(tx, envelope, fields);
  } catch {
    return Option.none();
  }
}

export function signingPayload(envelope: UnsignedEnvelope): Uint8Array {
  return TransactionBuilder.fromXDR(envelope, networkPassphrase).hash();
}
