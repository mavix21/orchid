import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type DestinationAddress,
  LinkRecipient,
  PaymentLinkReceipt,
  type PaymentMemo,
  Profile,
  type TransferDraft,
  TransferOrder,
  assetKey,
} from "../contract";
import type {
  ClaimableFacts,
  PaymentLinkFacts,
} from "../stellar/asset-envelopes";
import { type PaymentFacts, readEnvelope } from "../stellar/envelopes";
import { network } from "../stellar/network";
import { type PublicDeviceWallet, receiptJson } from "./key-store";
import type { PaymentReview, TransferIntent } from "./outcomes";

export const clockAllowance = 60;

export const orderRevision = (wallet: PublicDeviceWallet) =>
  wallet.transferRevision ?? 0;

export const sameOrderSlot = (
  left: PublicDeviceWallet,
  right: PublicDeviceWallet,
) =>
  left.transfer?.id === right.transfer?.id &&
  left.approvedUntil === right.approvedUntil &&
  receiptJson(left.linkReceipt ?? null) ===
    receiptJson(right.linkReceipt ?? null) &&
  orderRevision(left) === orderRevision(right);

export const orderJson = Schema.encodeSync(
  Schema.fromJsonString(TransferOrder),
);

const sameMemo = (
  drafted: PaymentMemo | undefined,
  ordered: PaymentMemo | undefined,
) => drafted?.type === ordered?.type && drafted?.value === ordered?.value;

const destination = (order: TransferOrder, draft: TransferDraft) =>
  Match.valueTags(order.to, {
    Address: ({ value }) => Option.some(value),
    Username: ({ value }) =>
      draft.recipient instanceof Profile && draft.recipient.username === value
        ? Option.some<DestinationAddress>(draft.recipient.address)
        : Option.none<DestinationAddress>(),
    PaymentLink: ({ value }) =>
      draft.recipient instanceof LinkRecipient &&
      draft.recipient.address === value
        ? Option.some<DestinationAddress>(value)
        : Option.none<DestinationAddress>(),
    Phone: () => Option.none<DestinationAddress>(),
  });

export const approvalOutstanding = (wallet: PublicDeviceWallet, now: number) =>
  wallet.approvedUntil !== undefined &&
  wallet.approvedUntil + clockAllowance >= now;

export const matchesIntent = (
  wallet: PublicDeviceWallet,
  intent: TransferIntent,
) =>
  wallet.transfer !== undefined &&
  orderJson(wallet.transfer) ===
    orderJson(
      new TransferOrder({
        ...intent,
        id: wallet.transfer.id,
        from: wallet.address,
      }),
    );

export const nextLinkReceipt = (
  current: PaymentLinkReceipt | undefined,
  facts: PaymentLinkFacts,
) => {
  const sameOrder =
    current !== undefined &&
    current.network === network &&
    current.address === facts.to &&
    assetKey(current.asset) === assetKey(facts.asset) &&
    current.amount === facts.amount;

  const prior = sameOrder ? current.attempts : [];

  const attempts = prior.includes(facts.balance)
    ? prior
    : [...prior, facts.balance];

  return new PaymentLinkReceipt({
    network,
    address: facts.to,
    asset: facts.asset,
    amount: facts.amount,
    balance: facts.balance,
    attempts,
  });
};

export const orderedFacts = (
  wallet: PublicDeviceWallet,
  order: TransferOrder,
  draft: TransferDraft,
) => {
  const facts = readEnvelope(draft.request.envelope);
  const to = destination(order, draft);

  if (Option.isNone(facts) || Option.isNone(to)) return Option.none();

  const drafted = facts.value;

  if (
    !(
      Predicate.isTagged(drafted, "PaymentFacts") ||
      Predicate.isTagged(drafted, "ClaimableFacts") ||
      Predicate.isTagged(drafted, "PaymentLinkFacts")
    )
  )
    return Option.none();

  const moves =
    drafted.from === wallet.address &&
    drafted.to === to.value &&
    assetKey(drafted.asset) === assetKey(order.asset) &&
    drafted.amount === order.amount;

  const matches = Predicate.isTagged(drafted, "PaymentLinkFacts")
    ? moves &&
      Predicate.isTagged(order.to, "PaymentLink") &&
      order.memo === undefined &&
      draft.recipient instanceof LinkRecipient &&
      draft.recipient.address === drafted.to &&
      wallet.reserveSponsor !== undefined &&
      drafted.reserveSponsor === wallet.reserveSponsor &&
      (draft.claimable === undefined || draft.claimable === drafted.balance)
    : Predicate.isTagged(order.to, "PaymentLink")
      ? false
      : Predicate.isTagged(drafted, "PaymentFacts")
        ? moves && sameMemo(drafted.memo, order.memo)
        : moves &&
          order.memo === undefined &&
          draft.recipient instanceof Profile &&
          wallet.reserveSponsor !== undefined &&
          drafted.reserveSponsor === wallet.reserveSponsor &&
          (draft.claimable === undefined ||
            draft.claimable === drafted.balance);

  return matches ? Option.some(drafted) : Option.none();
};

export const reviewed =
  (review: Option.Option<PaymentReview>) =>
  (facts: PaymentFacts | ClaimableFacts | PaymentLinkFacts) =>
    Option.match(review, {
      onNone: () => true,
      onSome: (shown) =>
        facts.to === shown.to &&
        (Predicate.isTagged(facts, "ClaimableFacts") ||
          Predicate.isTagged(facts, "PaymentLinkFacts")) === shown.claimable,
    });
