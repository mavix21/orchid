import {
  Account,
  Asset as StellarAsset,
  Claimant,
  Operation,
  Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Asset,
  HeldFundsId,
  PositiveAmount,
  UnsignedEnvelope,
  formatAmount,
  parseAmount,
  precisionOf,
} from "../contract";
import { fromStellarAsset, toStellarAsset } from "./assets";
import { bounds } from "./bounds";
import { reclaimDelay } from "../policy";
import { baseFee, networkPassphrase } from "./network";

export class TrustlineFacts extends Schema.TaggedClass<TrustlineFacts>()(
  "TrustlineFacts",
  {
    ...bounds,
    address: AccountAddress,
    reserveSponsor: AccountAddress,
    asset: Asset,
  },
) {}

export class TrustlineRemovalFacts extends Schema.TaggedClass<TrustlineRemovalFacts>()(
  "TrustlineRemovalFacts",
  {
    ...bounds,
    address: AccountAddress,
    asset: Asset,
  },
) {}

export class ClaimableFacts extends Schema.TaggedClass<ClaimableFacts>()(
  "ClaimableFacts",
  {
    ...bounds,
    from: AccountAddress,
    to: AccountAddress,
    asset: Asset,
    amount: PositiveAmount,
    reserveSponsor: AccountAddress,
    heldFunds: HeldFundsId,
  },
) {}

export class PaymentLinkFacts extends Schema.TaggedClass<PaymentLinkFacts>()(
  "PaymentLinkFacts",
  {
    ...bounds,
    from: AccountAddress,
    to: AccountAddress,
    asset: Asset,
    amount: PositiveAmount,
    reserveSponsor: AccountAddress,
    heldFunds: HeldFundsId,
  },
) {}

export class ClaimFacts extends Schema.TaggedClass<ClaimFacts>()("ClaimFacts", {
  ...bounds,
  address: AccountAddress,
  heldFunds: HeldFundsId,
  opens: Schema.optional(Asset),
  reserveSponsor: Schema.optional(AccountAddress),
}) {}

export type AssetFacts =
  | TrustlineFacts
  | TrustlineRemovalFacts
  | ClaimableFacts
  | PaymentLinkFacts
  | ClaimFacts;

interface Drafting {
  readonly source: Account;
  readonly minTime: number;
  readonly maxTime: number;
}

export interface TrustlineInput extends Drafting {
  readonly reserveSponsor: AccountAddress;
  readonly asset: Asset;
}

export interface TrustlineRemovalInput extends Drafting {
  readonly asset: Asset;
}

export interface ClaimableInput extends Drafting {
  readonly reserveSponsor: AccountAddress;
  readonly to: AccountAddress;
  readonly asset: Asset;
  readonly amount: PositiveAmount;
}

export interface SponsoredTrustline {
  readonly asset: Asset;
  readonly reserveSponsor: AccountAddress;
}

export interface ClaimInput extends Drafting {
  readonly heldFunds: HeldFundsId;
  readonly opens?: SponsoredTrustline;
}

const start = (input: Drafting) =>
  new TransactionBuilder(input.source, { fee: baseFee, networkPassphrase });

const finish = (builder: TransactionBuilder, input: Drafting) =>
  Schema.decodeSync(UnsignedEnvelope)(
    builder.setTimebounds(input.minTime, input.maxTime).build().toXDR(),
  );

const sponsored = (
  builder: TransactionBuilder,
  reserveSponsor: AccountAddress,
  operation: xdr.Operation,
) =>
  builder
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        source: reserveSponsor,
        sponsoredId: builder.source.accountId(),
      }),
    )
    .addOperation(operation)
    .addOperation(Operation.endSponsoringFutureReserves({}));

export function draftTrustline(input: TrustlineInput): UnsignedEnvelope {
  return finish(
    sponsored(
      start(input),
      input.reserveSponsor,
      Operation.changeTrust({ asset: toStellarAsset(input.asset) }),
    ),
    input,
  );
}

export function draftTrustlineRemoval(
  input: TrustlineRemovalInput,
): UnsignedEnvelope {
  return finish(
    start(input).addOperation(
      Operation.changeTrust({
        asset: toStellarAsset(input.asset),
        limit: "0",
      }),
    ),
    input,
  );
}

export function draftClaimable(input: ClaimableInput): UnsignedEnvelope {
  return finish(
    sponsored(
      start(input),
      input.reserveSponsor,
      Operation.createClaimableBalance({
        asset: toStellarAsset(input.asset),
        amount: formatAmount(input.amount, precisionOf(input.asset)),
        claimants: [
          new Claimant(input.to, Claimant.predicateUnconditional()),
          new Claimant(
            input.source.accountId(),
            Claimant.predicateNot(
              Claimant.predicateBeforeRelativeTime(reclaimDelay.toString()),
            ),
          ),
        ],
      }),
    ),
    input,
  );
}

export function draftPaymentLink(input: ClaimableInput): UnsignedEnvelope {
  return finish(
    sponsored(
      start(input),
      input.reserveSponsor,
      Operation.createClaimableBalance({
        asset: toStellarAsset(input.asset),
        amount: formatAmount(input.amount, precisionOf(input.asset)),
        claimants: [
          new Claimant(input.to, Claimant.predicateUnconditional()),
          new Claimant(
            input.source.accountId(),
            Claimant.predicateUnconditional(),
          ),
        ],
      }),
    ),
    input,
  );
}

export function draftClaim(input: ClaimInput): UnsignedEnvelope {
  const claim = Operation.claimClaimableBalance({ balanceId: input.heldFunds });

  return finish(
    (input.opens
      ? sponsored(
          start(input),
          input.opens.reserveSponsor,
          Operation.changeTrust({ asset: toStellarAsset(input.opens.asset) }),
        )
      : start(input)
    ).addOperation(claim),
    input,
  );
}

interface Pinned {
  readonly sequence: string;
  readonly minTime: number;
  readonly maxTime: number;
}

export function claimableBalanceOf(
  envelope: UnsignedEnvelope,
): Option.Option<HeldFundsId> {
  const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase);

  return tx instanceof Transaction &&
    tx.operations[1]?.type === "createClaimableBalance"
    ? Option.some(Schema.decodeSync(HeldFundsId)(tx.getClaimableBalanceId(1)))
    : Option.none();
}

export function readAssetEnvelope(
  tx: Transaction,
  envelope: UnsignedEnvelope,
  fields: Pinned,
): Option.Option<AssetFacts> {
  const address = Schema.decodeSync(AccountAddress)(tx.source);

  const drafting = (): Drafting => ({
    source: new Account(tx.source, (BigInt(tx.sequence) - 1n).toString()),
    minTime: fields.minTime,
    maxTime: fields.maxTime,
  });

  const [first, second, , fourth] = tx.operations;

  if (first?.type === "beginSponsoringFutureReserves" && first.source) {
    const reserveSponsor = Schema.decodeSync(AccountAddress)(first.source);

    if (
      second?.type === "changeTrust" &&
      second.line instanceof StellarAsset &&
      !second.line.isNative()
    ) {
      const asset = fromStellarAsset(second.line);

      if (
        fourth?.type === "claimClaimableBalance" &&
        draftClaim({
          ...drafting(),
          heldFunds: Schema.decodeSync(HeldFundsId)(fourth.balanceId),
          opens: { asset, reserveSponsor },
        }) === envelope
      )
        return Option.some(
          new ClaimFacts({
            ...fields,
            address,
            heldFunds: Schema.decodeSync(HeldFundsId)(fourth.balanceId),
            opens: asset,
            reserveSponsor,
          }),
        );

      if (draftTrustline({ ...drafting(), reserveSponsor, asset }) === envelope)
        return Option.some(
          new TrustlineFacts({ ...fields, address, reserveSponsor, asset }),
        );
    }

    if (second?.type === "createClaimableBalance") {
      const asset = fromStellarAsset(second.asset);
      const amount = parseAmount(second.amount, precisionOf(asset));

      const to = Schema.decodeUnknownSync(AccountAddress)(
        second.claimants[0]?.destination,
      );

      if (
        Option.isSome(amount) &&
        to !== address &&
        draftClaimable({
          ...drafting(),
          reserveSponsor,
          to,
          asset,
          amount: amount.value,
        }) === envelope
      )
        return Option.some(
          new ClaimableFacts({
            ...fields,
            from: address,
            to,
            asset,
            amount: amount.value,
            reserveSponsor,
            heldFunds: Schema.decodeSync(HeldFundsId)(
              tx.getClaimableBalanceId(1),
            ),
          }),
        );

      if (
        Option.isSome(amount) &&
        to !== address &&
        draftPaymentLink({
          ...drafting(),
          reserveSponsor,
          to,
          asset,
          amount: amount.value,
        }) === envelope
      )
        return Option.some(
          new PaymentLinkFacts({
            ...fields,
            from: address,
            to,
            asset,
            amount: amount.value,
            reserveSponsor,
            heldFunds: Schema.decodeSync(HeldFundsId)(
              tx.getClaimableBalanceId(1),
            ),
          }),
        );
    }
  }

  if (
    first?.type === "changeTrust" &&
    first.line instanceof StellarAsset &&
    !first.line.isNative()
  ) {
    const asset = fromStellarAsset(first.line);

    if (draftTrustlineRemoval({ ...drafting(), asset }) === envelope)
      return Option.some(
        new TrustlineRemovalFacts({ ...fields, address, asset }),
      );
  }

  if (first?.type === "claimClaimableBalance") {
    const heldFunds = Schema.decodeSync(HeldFundsId)(first.balanceId);

    if (draftClaim({ ...drafting(), heldFunds }) === envelope)
      return Option.some(new ClaimFacts({ ...fields, address, heldFunds }));
  }

  return Option.none();
}
