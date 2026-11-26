import type { Account } from "@stellar/stellar-sdk";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  type AccountAddress,
  type SigningRequest,
  assetKey,
} from "../contract";
import { type AssetPlan, plannedSequence } from "../stellar/asset-plans";
import { readEnvelope } from "../stellar/envelopes";
import { sameMemo } from "../stellar/memo";
import type { ChainUnreachable } from "./chain-errors.server";
import { type LinkReceive, linkAccountPlan } from "./chain-links.server";
import type { AccountState } from "./ledger.server";

export type DraftPurpose = Data.TaggedEnum<{
  Transfer: { readonly from: AccountAddress };
  AssetChange: {
    readonly address: AccountAddress;
    readonly plan: AssetPlan;
  };
  LinkPayout: { readonly receive: LinkReceive };
}>;

export const DraftPurpose = Data.taggedEnum<DraftPurpose>();

export interface DraftChain {
  draftCurrent(
    request: SigningRequest,
    purpose: DraftPurpose,
  ): Effect.Effect<boolean, ChainUnreachable>;
}

type SequenceNumber = ReturnType<Account["sequenceNumber"]>;

export const draftChain = (
  account: (
    address: AccountAddress,
  ) => Effect.Effect<Option.Option<AccountState>, ChainUnreachable>,
): DraftChain => {
  const follows = (
    source: Option.Option<AccountState>,
    sequence: SequenceNumber,
  ) =>
    Option.exists(
      source,
      (state) => BigInt(state.sequence) + 1n === BigInt(sequence),
    );

  const transferCurrent = Effect.fn("Chain.transferDraftCurrent")(function* (
    request: SigningRequest,
    from: AccountAddress,
  ) {
    const source = yield* account(from);

    return Option.exists(
      readEnvelope(request.envelope),
      (facts) =>
        (Predicate.isTagged(facts, "PaymentFacts") ||
          Predicate.isTagged(facts, "ClaimableFacts") ||
          Predicate.isTagged(facts, "PaymentLinkFacts")) &&
        follows(source, facts.sequence),
    );
  });

  const assetCurrent = Effect.fn("Chain.assetDraftCurrent")(function* (
    request: SigningRequest,
    address: AccountAddress,
    plan: AssetPlan,
  ) {
    const source = yield* account(address);

    return Option.exists(plannedSequence(request.envelope, plan), (sequence) =>
      follows(source, sequence),
    );
  });

  const linkReceiveCurrent = Effect.fn("Chain.linkReceiveDraftCurrent")(
    function* (request: SigningRequest, receive: LinkReceive) {
      const facts = readEnvelope(request.envelope);

      if (
        Option.isNone(facts) ||
        !Predicate.isTagged(facts.value, "LinkReceiveFacts")
      )
        return false;

      const plan = linkAccountPlan(yield* account(receive.link));
      const channel = yield* account(facts.value.channel);

      return (
        plan !== "Refuse" &&
        facts.value.createsLinkAccount === (plan === "Create") &&
        facts.value.link === receive.link &&
        facts.value.balance === receive.balance &&
        facts.value.destination === receive.destination &&
        sameMemo(facts.value.memo, receive.memo) &&
        assetKey(facts.value.asset) === assetKey(receive.asset) &&
        facts.value.amount === receive.amount &&
        follows(channel, facts.value.sequence)
      );
    },
  );

  return {
    draftCurrent: (request, purpose) =>
      DraftPurpose.$match(purpose, {
        Transfer: ({ from }) => transferCurrent(request, from),
        AssetChange: ({ address, plan }) =>
          assetCurrent(request, address, plan),
        LinkPayout: ({ receive }) => linkReceiveCurrent(request, receive),
      }),
  };
};
