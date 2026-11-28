import type { AssessmentStep, RecipientStep } from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

export const RefusalReason = Schema.Literals([
  "wallet_not_ready",
  "wallet_unavailable",
  "unknown_recipient",
  "invalid_address",
  "phone_not_supported",
  "asset_not_held",
  "amount_invalid",
  "insufficient_balance",
  "memo_required",
  "memo_not_from_user",
  "memo_not_allowed",
  "recipient_cannot_receive",
  "sender_busy",
  "link_limit_reached",
  "asset_unsupported",
  "link_not_found",
]);

export type RefusalReason = typeof RefusalReason.Type;

export class Refusal extends Schema.TaggedError<Refusal>()("Refusal", {
  reason: RefusalReason,
}) {}

export const refused = (reason: RefusalReason) => new Refusal({ reason });

export const recipientRefusalOf = (
  step: Exclude<RecipientStep, { readonly _tag: "RecipientCheck" }>,
) =>
  Match.value(step).pipe(
    Match.tagsExhaustive({
      UnknownRecipient: () => refused("unknown_recipient"),
      PhoneNotSupported: () => refused("phone_not_supported"),
      InvalidAddress: () => refused("invalid_address"),
    }),
  );

export const assessmentRefusalOf = (
  step: Exclude<AssessmentStep, { readonly _tag: "TransferAssessment" }>,
) =>
  Match.value(step).pipe(
    Match.tagsExhaustive({
      NotOpened: () => refused("wallet_not_ready"),
      UnknownRecipient: () => refused("unknown_recipient"),
      PhoneNotSupported: () => refused("phone_not_supported"),
      InsufficientBalance: () => refused("insufficient_balance"),
      SenderBusy: () => refused("sender_busy"),
      InvalidAddress: () => refused("invalid_address"),
      ExternalMemoRequired: () => refused("memo_required"),
      MemoNotAllowed: () => refused("memo_not_allowed"),
      RecipientCannotReceive: () => refused("recipient_cannot_receive"),
      UnclaimedFundsLimitReached: () => refused("link_limit_reached"),
      AssetUnsupported: () => refused("asset_unsupported"),
    }),
  );
