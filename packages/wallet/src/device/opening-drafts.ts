import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type {
  AccountAddress,
  OpeningDraft,
  RecoveryDraft,
  SigningRequest,
} from "../contract";
import { pinnedSequence, readEnvelope } from "../stellar/envelopes";
import {
  approvalMargin,
  paymentLifetime,
  recoveryDelay,
  recoveryDraftLifetime,
  recoveryWindow,
} from "../stellar/network";
import type { PublicDeviceWallet } from "./key-store";
import { OpeningReview } from "./outcomes";
import { clockAllowance } from "./transfer-drafts";

export type OpeningStanding = "current" | "expiring" | "stale";

export const reviewJson = Schema.encodeSync(
  Schema.fromJsonString(OpeningReview),
);

export const reviewFromJson = Schema.decodeSync(
  Schema.fromJsonString(OpeningReview),
);

export const requestsOf = (
  draft: OpeningDraft | RecoveryDraft,
): readonly [SigningRequest, ...Array<SigningRequest>] =>
  Predicate.isTagged(draft, "OpeningDraft") && draft.recovery !== undefined
    ? [draft.request, draft.recovery]
    : [draft.request];

const timing = (
  maxTime: number,
  request: SigningRequest,
  nowMillis: number,
): OpeningStanding => {
  if (
    DateTime.toEpochMillis(request.expiresAt) !== maxTime * 1000 ||
    maxTime > Math.floor(nowMillis / 1000) + paymentLifetime + clockAllowance
  )
    return "stale";

  return maxTime * 1000 - nowMillis >= approvalMargin * 1000
    ? "current"
    : "expiring";
};

const pairedStanding = (
  wallet: PublicDeviceWallet,
  draft: OpeningDraft,
  nowMillis: number,
): OpeningStanding => {
  const opening = readEnvelope(draft.request.envelope);

  if (
    Option.isNone(opening) ||
    !Predicate.isTagged(opening.value, "OpeningFacts") ||
    opening.value.address !== wallet.address
  )
    return "stale";

  const facts = opening.value;
  const window = facts.window;

  if (window === undefined)
    return draft.recovery === undefined && !facts.createAccount
      ? timing(facts.maxTime, draft.request, nowMillis)
      : "stale";

  if (
    draft.recovery === undefined ||
    window.maxLedger - window.minLedger !== paymentLifetime + 1
  )
    return "stale";

  const recovery = readEnvelope(draft.recovery.envelope);

  if (
    Option.isNone(recovery) ||
    !Predicate.isTagged(recovery.value, "RecoveryFacts")
  )
    return "stale";

  const paired = recovery.value;

  return paired.address === wallet.address &&
    paired.reserveSponsor === facts.reserveSponsor &&
    BigInt(paired.sequence) === pinnedSequence(window) + 1n &&
    paired.minLedger === window.maxLedger &&
    paired.minTime >= facts.maxTime + recoveryDelay &&
    paired.maxTime - paired.minTime === recoveryWindow &&
    DateTime.toEpochMillis(draft.recovery.expiresAt) === paired.maxTime * 1000
    ? timing(facts.maxTime, draft.request, nowMillis)
    : "stale";
};

const standaloneStanding = (
  wallet: PublicDeviceWallet,
  draft: RecoveryDraft,
  nowMillis: number,
): OpeningStanding => {
  const recovery = readEnvelope(draft.request.envelope);

  if (
    Option.isNone(recovery) ||
    !Predicate.isTagged(recovery.value, "RecoveryFacts")
  )
    return "stale";

  const facts = recovery.value;

  if (
    facts.address !== wallet.address ||
    facts.reserveSponsor !== wallet.reserveSponsor ||
    facts.minLedger !== undefined ||
    facts.minTime <
      Math.floor(nowMillis / 1000) +
        recoveryDelay -
        recoveryDraftLifetime -
        clockAllowance ||
    facts.maxTime - facts.minTime !== recoveryWindow ||
    DateTime.toEpochMillis(draft.request.expiresAt) !== facts.maxTime * 1000
  )
    return "stale";

  return facts.maxTime * 1000 - nowMillis >= approvalMargin * 1000
    ? "current"
    : "expiring";
};

export const standingOf = (
  wallet: PublicDeviceWallet,
  shown: OpeningReview,
  nowMillis: number,
): OpeningStanding =>
  wallet.address !== shown.address || wallet.username !== shown.username
    ? "stale"
    : Predicate.isTagged(shown.draft, "OpeningDraft")
      ? pairedStanding(wallet, shown.draft, nowMillis)
      : standaloneStanding(wallet, shown.draft, nowMillis);

export const standingNow = (wallet: PublicDeviceWallet, shown: OpeningReview) =>
  Effect.map(DateTime.now, (now) =>
    standingOf(wallet, shown, DateTime.toEpochMillis(now)),
  );

export const reserveSponsorOf = (
  draft: OpeningDraft | RecoveryDraft,
): Option.Option<AccountAddress> => {
  const facts = readEnvelope(draft.request.envelope);

  if (Option.isNone(facts)) return Option.none();

  return Predicate.isTagged(facts.value, "OpeningFacts") ||
    Predicate.isTagged(facts.value, "RecoveryFacts")
    ? Option.some(facts.value.reserveSponsor)
    : Option.none();
};
