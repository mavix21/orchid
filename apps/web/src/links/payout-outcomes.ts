import {
  type Asset,
  type PayoutQuote,
  type PayoutQuoteChanged,
  type PayoutReview,
  PayoutUnavailable,
  type QuotePayoutOutcome,
  type ReviewPayoutOutcome,
} from "@workspace/wallet";
import * as Match from "effect/Match";

import { LinkScreen } from "@/links/outcomes";
import { m } from "@/paraglide/messages";
import type { DeviceFailure } from "@/send/use-wallet-task";

import {
  type ExternalClaimAction,
  reviewExternalResult,
} from "./external-claim-outcomes";

export type PayoutConclusion =
  | Exclude<QuotePayoutOutcome, PayoutQuote>
  | Exclude<ReviewPayoutOutcome, PayoutReview | PayoutQuoteChanged>
  | DeviceFailure;

export const payoutScreen = (
  outcome: PayoutConclusion,
  asset: Asset,
): LinkScreen<ExternalClaimAction> =>
  outcome instanceof PayoutUnavailable
    ? new LinkScreen(
        m.payout_unavailable_title(),
        m.payout_unavailable_note(),
        "done",
      )
    : Match.valueTags(reviewExternalResult(outcome, asset), {
        Concluded: ({ screen }) => screen,
        Field: () =>
          new LinkScreen<ExternalClaimAction>(
            m.payout_failed_title(),
            m.payout_not_sent(),
            "check",
          ),
        RetryLookup: () =>
          new LinkScreen<ExternalClaimAction>(
            m.payout_failed_title(),
            m.payout_not_sent(),
            "check",
          ),
      });
