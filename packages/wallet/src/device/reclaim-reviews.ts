import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { type AssetDraft, type AssetOrder, assetKey } from "../contract";
import { readEnvelope } from "../stellar/envelopes";
import { network } from "../stellar/network";
import type { PublicDeviceWallet } from "./key-store";
import { type PaymentLinkTarget, ReclaimReview } from "./outcomes";

export const reviewJson = Schema.encodeSync(
  Schema.fromJsonString(ReclaimReview),
);

export const reviewFromJson = Schema.decodeSync(
  Schema.fromJsonString(ReclaimReview),
);

export const reviewOf = (
  wallet: PublicDeviceWallet,
  order: AssetOrder,
  draft: AssetDraft,
  redrafted: boolean,
  { asset, amount }: PaymentLinkTarget,
) => {
  const facts = readEnvelope(draft.request.envelope);

  if (
    Option.isNone(facts) ||
    !Predicate.isTagged(facts.value, "ClaimFacts") ||
    !Predicate.isTagged(order.action, "ClaimBalance")
  )
    return Option.none();

  const claim = facts.value;

  const opensExactly =
    claim.opens === undefined
      ? claim.reserveSponsor === undefined
      : Predicate.isTagged(asset, "Issued") &&
        assetKey(claim.opens) === assetKey(asset) &&
        wallet.reserveSponsor !== undefined &&
        claim.reserveSponsor === wallet.reserveSponsor;

  if (
    order.wallet !== wallet.address ||
    claim.address !== wallet.address ||
    claim.balance !== order.action.balance ||
    !opensExactly
  )
    return Option.none();

  return Option.some({
    maxTime: claim.maxTime,
    review: new ReclaimReview({
      order,
      draft,
      redrafted,
      network,
      balance: claim.balance,
      asset,
      amount,
      opensTrustline: claim.opens,
    }),
  });
};
