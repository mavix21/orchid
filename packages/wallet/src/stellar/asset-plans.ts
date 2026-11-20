import * as Predicate from "effect/Predicate";
import type { Account } from "@stellar/stellar-sdk";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  BalanceId,
  type CloseTrustline,
  IssuedAsset,
  type OpenTrustline,
  type UnsignedEnvelope,
  assetKey,
} from "../contract";
import {
  draftClaim,
  draftTrustline,
  draftTrustlineRemoval,
} from "./asset-envelopes";
import { readEnvelope } from "./envelopes";

export const ClaimPlan = Schema.TaggedStruct("ClaimPlan", {
  balance: BalanceId,
  opens: Schema.optional(IssuedAsset),
});

export type AssetPlan =
  | typeof OpenTrustline.Type
  | typeof CloseTrustline.Type
  | typeof ClaimPlan.Type;

export interface PlanInput {
  readonly source: Account;
  readonly minTime: number;
  readonly maxTime: number;
  readonly reserveSponsor: AccountAddress;
}

export function draftPlan(plan: AssetPlan, input: PlanInput): UnsignedEnvelope {
  const { reserveSponsor, ...drafting } = input;

  return Match.valueTags(plan, {
    OpenTrustline: ({ asset }) =>
      draftTrustline({ ...drafting, reserveSponsor, asset }),
    CloseTrustline: ({ asset }) =>
      draftTrustlineRemoval({ ...drafting, asset }),
    ClaimPlan: ({ balance, opens }) =>
      opens
        ? draftClaim({
            ...drafting,
            balance,
            opens: { asset: opens, reserveSponsor },
          })
        : draftClaim({ ...drafting, balance }),
  });
}

export function plannedSequence(
  envelope: UnsignedEnvelope,
  plan: AssetPlan,
): Option.Option<string> {
  return readEnvelope(envelope).pipe(
    Option.filter((facts) =>
      Match.valueTags(plan, {
        OpenTrustline: ({ asset }) =>
          Predicate.isTagged(facts, "TrustlineFacts") &&
          assetKey(facts.asset) === assetKey(asset),
        CloseTrustline: ({ asset }) =>
          Predicate.isTagged(facts, "TrustlineRemovalFacts") &&
          assetKey(facts.asset) === assetKey(asset),
        ClaimPlan: ({ balance, opens }) =>
          Predicate.isTagged(facts, "ClaimFacts") &&
          facts.balance === balance &&
          (facts.opens ? assetKey(facts.opens) : undefined) ===
            (opens ? assetKey(opens) : undefined),
      }),
    ),
    Option.map((facts) => facts.sequence),
  );
}
