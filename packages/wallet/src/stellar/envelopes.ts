import {
  Account,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Asset,
  BalanceId,
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
import { type LinkReceiveFacts, readLinkReceive } from "./link-receive";
import { fromStellarMemo, toStellarMemo } from "./memo";
import { baseFee, networkPassphrase, usdc } from "./network";

export type EnvelopeFacts =
  | OpeningFacts
  | PaymentFacts
  | RecoveryFacts
  | AssetFacts
  | LinkReceiveFacts;

export const LedgerWindow = Schema.Struct({
  minLedger: Schema.Number,
  maxLedger: Schema.Number,
});

export type LedgerWindow = typeof LedgerWindow.Type;

export const pinnedSequence = (window: LedgerWindow): bigint =>
  BigInt(window.maxLedger - 1) << 32n;

export class OpeningFacts extends Schema.TaggedClass<OpeningFacts>()(
  "OpeningFacts",
  {
    ...bounds,
    address: AccountAddress,
    reserveSponsor: AccountAddress,
    createAccount: Schema.Boolean,
    window: Schema.optional(LedgerWindow),
    claim: Schema.optional(BalanceId),
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
    minLedger: Schema.optional(Schema.Number),
  },
) {}

export interface OpeningInput {
  readonly source: Account;
  readonly address: AccountAddress;
  readonly minTime: number;
  readonly maxTime: number;
  readonly createAccount: boolean;
  readonly window?: LedgerWindow;
  readonly claim?: BalanceId;
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
  readonly minLedger?: number;
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

  builder.addOperation(
    Operation.changeTrust({ source: input.address, asset: usdc }),
  );

  if (input.window)
    builder
      .addOperation(
        Operation.bumpSequence({
          source: input.address,
          bumpTo: pinnedSequence(input.window).toString(),
        }),
      )
      .setLedgerbounds(input.window.minLedger, input.window.maxLedger);

  builder.addOperation(
    Operation.endSponsoringFutureReserves({ source: input.address }),
  );

  if (input.claim)
    builder.addOperation(
      Operation.claimClaimableBalance({
        source: input.address,
        balanceId: input.claim,
      }),
    );

  return Schema.decodeSync(UnsignedEnvelope)(
    builder.setTimebounds(input.minTime, input.maxTime).build().toXDR(),
  );
}

export function draftPayment(input: PaymentInput): UnsignedEnvelope {
  return Schema.decodeSync(UnsignedEnvelope)(
    new TransactionBuilder(input.source, {
      fee: baseFee,
      networkPassphrase,
      memo: toStellarMemo(input.memo),
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
  const builder = new TransactionBuilder(input.source, {
    fee: baseFee,
    networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset: usdc, limit: "0" }))
    .addOperation(Operation.accountMerge({ destination: input.reserveSponsor }))
    .setTimebounds(input.minTime, input.maxTime);

  if (input.minLedger !== undefined)
    builder.setLedgerbounds(input.minLedger, 0);

  return Schema.decodeSync(UnsignedEnvelope)(builder.build().toXDR());
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
      const window = tx.ledgerBounds;
      const last = tx.operations.at(-1);

      const claim =
        last?.type === "claimClaimableBalance"
          ? Schema.decodeSync(BalanceId)(last.balanceId)
          : undefined;

      if (
        draftOpening({
          source: source(),
          address,
          minTime,
          maxTime,
          createAccount,
          window,
          claim,
        }) === envelope
      )
        return Option.some(
          new OpeningFacts({
            ...fields,
            address,
            reserveSponsor,
            createAccount,
            window,
            claim,
          }),
        );
    }

    if (first?.type === "payment") {
      const reference = fromStellarMemo(tx.memo);
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

      const minLedger = tx.ledgerBounds?.minLedger;

      if (
        minTime > 0 &&
        draftRecovery({
          source: source(),
          reserveSponsor,
          minTime,
          maxTime,
          minLedger,
        }) === envelope
      )
        return Option.some(
          new RecoveryFacts({
            ...fields,
            address,
            reserveSponsor,
            minLedger,
          }),
        );
    }

    return Option.orElse(readAssetEnvelope(tx, envelope, fields), () =>
      readLinkReceive(tx, envelope, fields),
    );
  } catch {
    return Option.none();
  }
}

export function signingPayload(envelope: UnsignedEnvelope): Uint8Array {
  return TransactionBuilder.fromXDR(envelope, networkPassphrase).hash();
}
