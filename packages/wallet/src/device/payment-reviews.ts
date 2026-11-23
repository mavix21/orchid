import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { TransferDraft, TransferOrder } from "../contract";
import type { ClaimableFacts } from "../stellar/asset-envelopes";
import type { PaymentFacts } from "../stellar/envelopes";
import { approvalMargin, paymentLifetime } from "../stellar/network";
import type { PublicDeviceWallet } from "./key-store";
import { PaymentReview } from "./outcomes";
import {
  approvalOutstanding,
  clockAllowance,
  orderJson,
  orderedFacts,
} from "./transfer-drafts";

const reviewJson = Schema.encodeSync(Schema.fromJsonString(PaymentReview));

type ReviewStanding = "current" | "expiring" | "stale";

const reviewFrom = (
  order: TransferOrder,
  draft: TransferDraft,
  redrafted: boolean,
  facts: PaymentFacts | ClaimableFacts,
) =>
  new PaymentReview({
    order,
    draft,
    redrafted,
    to: facts.to,
    username: Predicate.isTagged(order.to, "Username")
      ? order.to.value
      : undefined,
    asset: facts.asset,
    amount: facts.amount,
    memo: Predicate.isTagged(facts, "PaymentFacts") ? facts.memo : undefined,
    claimable: Predicate.isTagged(facts, "ClaimableFacts"),
    memoRequired: draft.memoRequired,
  });

export const reviewOf = (
  wallet: PublicDeviceWallet,
  order: TransferOrder,
  draft: TransferDraft,
  redrafted: boolean,
) =>
  Option.flatMap(orderedFacts(wallet, order, draft), (facts) =>
    Predicate.isTagged(facts, "PaymentLinkFacts")
      ? Option.none()
      : Option.some({
          facts,
          review: reviewFrom(order, draft, redrafted, facts),
        }),
  );

const standingOf = (
  wallet: PublicDeviceWallet,
  shown: PaymentReview,
  nowMillis: number,
): ReviewStanding => {
  const order = wallet.transfer;

  if (order === undefined || orderJson(order) !== orderJson(shown.order))
    return "stale";

  const derived = reviewOf(wallet, order, shown.draft, shown.redrafted);
  const now = Math.floor(nowMillis / 1000);

  if (
    Option.isNone(derived) ||
    reviewJson(derived.value.review) !== reviewJson(shown) ||
    approvalOutstanding(wallet, now) ||
    derived.value.facts.maxTime > now + paymentLifetime + clockAllowance
  )
    return "stale";

  const deadline = Math.min(
    derived.value.facts.maxTime * 1000,
    DateTime.toEpochMillis(shown.draft.request.expiresAt),
  );

  return deadline - nowMillis >= approvalMargin * 1000 ? "current" : "expiring";
};

export const standingNow = (wallet: PublicDeviceWallet, shown: PaymentReview) =>
  Effect.map(DateTime.now, (now) =>
    standingOf(wallet, shown, DateTime.toEpochMillis(now)),
  );
