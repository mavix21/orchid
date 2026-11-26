import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  type Approval,
  type AssetDraft,
  AssetOrder,
  type AssetStep,
  AssetOrderId,
  type LinkSecret,
  type PaymentLinkOpen,
  type PaymentLinkStep,
  ReceiveLink,
  type WalletPort,
  type WalletUnavailable,
  assetKey,
} from "../contract";
import { readEnvelope } from "../stellar/envelopes";
import { approvalMargin } from "../policy";
import { network } from "../stellar/network";
import {
  type ClaimKind,
  type ClaimReviews,
  reviewedClaims,
} from "./claim-reviews";
import type {
  CorruptDeviceWallet,
  KeyStore,
  KeyStoreUnavailable,
  PublicDeviceWallet,
} from "./key-store";
import {
  type ConfirmLinkReceiveOutcome,
  type LinkReceiveTarget,
  LinkReceiveReview,
  LinkSecretMismatch,
  NoWallet,
  type PaymentLinkOutcome,
  type ReviewLinkReceiveOutcome,
} from "./outcomes";
import { pendingSteps, pollSchedule } from "./polling";
import { linkKeyOf, type LinkCode } from "./link-code";
import { approveWithLinkSecret } from "./signing";

export const receiveCurrentUntil = (review: LinkReceiveReview) =>
  DateTime.toEpochMillis(review.draft.request.expiresAt) -
  approvalMargin * 1000;

export const receiveReviewJson = Schema.encodeSync(
  Schema.fromJsonString(LinkReceiveReview),
);

export const receiveReviewFromJson = Schema.decodeSync(
  Schema.fromJsonString(LinkReceiveReview),
);

export const linkSecretFor = (
  link: AccountAddress,
  code: LinkCode,
): Option.Option<LinkSecret> =>
  linkKeyOf(code).pipe(
    Option.filter((key) => key.address === link),
    Option.map((key) => key.secret),
  );

export const receiveReviewOf = (
  wallet: PublicDeviceWallet,
  order: AssetOrder,
  draft: AssetDraft,
  redrafted: boolean,
  target: LinkReceiveTarget,
) => {
  const facts = readEnvelope(draft.request.envelope);
  const { action } = order;

  if (
    Option.isNone(facts) ||
    !Predicate.isTagged(facts.value, "LinkReceiveFacts") ||
    !Predicate.isTagged(action, "ReceiveLink")
  )
    return Option.none();

  const receive = facts.value;

  if (
    order.wallet !== wallet.address ||
    wallet.reserveSponsor === undefined ||
    receive.reserveSponsor !== wallet.reserveSponsor ||
    receive.destination !== wallet.address ||
    receive.memo !== undefined ||
    receive.link !== action.link ||
    action.link !== target.link ||
    receive.link === wallet.address ||
    receive.channel === receive.link ||
    receive.channel === wallet.address ||
    receive.balance !== action.balance ||
    action.balance !== target.balance ||
    assetKey(receive.asset) !== assetKey(target.asset) ||
    receive.amount !== target.amount ||
    (Predicate.isTagged(receive.asset, "Issued") &&
      receive.asset.issuer === wallet.address)
  )
    return Option.none();

  return Option.some({
    maxTime: receive.maxTime,
    review: new LinkReceiveReview({
      order,
      draft,
      redrafted,
      network,
      link: target.link,
      balance: target.balance,
      asset: target.asset,
      amount: target.amount,
      sender: target.sender,
    }),
  });
};

export const linkReceiveKind: ClaimKind<LinkReceiveTarget, LinkReceiveReview> =
  {
    reviewOf: receiveReviewOf,
    targetOf: (shown) => shown,
    json: receiveReviewJson,
    fromJson: receiveReviewFromJson,
    concluded: () => Effect.void,
  };

export const receiveOrder = (
  wallet: AccountAddress,
  target: LinkReceiveTarget,
) =>
  new AssetOrder({
    id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
    wallet,
    action: ReceiveLink.make({ link: target.link, balance: target.balance }),
  });

export class OpenedLink extends Data.TaggedClass(
  "OpenedLink",
)<LinkReceiveTarget> {}

export const openLink = Effect.fn("Device.openLink")(function* (
  port: Pick<WalletPort, "paymentLink">,
  code: LinkCode,
): Effect.fn.Return<
  OpenedLink | Exclude<PaymentLinkStep, PaymentLinkOpen> | LinkSecretMismatch,
  WalletUnavailable
> {
  const key = linkKeyOf(code);

  if (Option.isNone(key)) return new LinkSecretMismatch();

  const link = key.value.address;

  const status = yield* port.paymentLink(link);

  return Predicate.isTagged(status, "PaymentLinkOpen")
    ? new OpenedLink({
        link,
        balance: status.balance,
        asset: status.asset,
        amount: status.amount,
        sender: status.sender,
      })
    : status;
});

export const releaseReceive = Effect.fn("Device.releaseReceive")(function* (
  port: Pick<WalletPort, "manage">,
  order: AssetOrder,
  approval: Approval,
): Effect.fn.Return<AssetStep, WalletUnavailable> {
  const released = yield* port.manage(order, Option.some(approval));

  if (!Predicate.isTagged(released, "AssetPending")) return released;

  return yield* Effect.repeat(port.manage(order, Option.none()), {
    schedule: pollSchedule<AssetStep>(
      (step) => Predicate.isTagged(step, "AssetPending"),
      () => true,
    ).pipe(Schedule.upTo({ times: pendingSteps - 2 })),
  });
});

export function deviceLinkReceive(
  port: WalletPort,
  store: KeyStore,
  reviews: ClaimReviews,
) {
  const claims = reviewedClaims(port, reviews, linkReceiveKind);

  const status = Effect.fn("Device.paymentLink")(function* (
    code: LinkCode,
  ): Effect.fn.Return<PaymentLinkOutcome, WalletUnavailable> {
    const key = linkKeyOf(code);

    if (Option.isNone(key)) return new LinkSecretMismatch();

    return yield* port.paymentLink(key.value.address);
  });

  const review = Effect.fn("Device.reviewLinkReceive")(function* (
    code: LinkCode,
  ): Effect.fn.Return<
    ReviewLinkReceiveOutcome,
    WalletUnavailable | KeyStoreUnavailable
  > {
    const target = yield* openLink(port, code);

    if (!(target instanceof OpenedLink)) return target;

    const stored = yield* store.readPublic();

    if (Option.isNone(stored)) return new NoWallet();

    return yield* claims.review(
      stored.value,
      receiveOrder(stored.value.address, target),
      target,
    );
  });

  const confirm = Effect.fn("Device.confirmLinkReceive")(function* (
    shown: LinkReceiveReview,
    code: LinkCode,
  ): Effect.fn.Return<
    ConfirmLinkReceiveOutcome,
    WalletUnavailable | KeyStoreUnavailable | CorruptDeviceWallet
  > {
    const secret = linkSecretFor(shown.link, code);

    if (Option.isNone(secret)) return new LinkSecretMismatch();

    return yield* claims.confirm(shown, (requests) =>
      approveWithLinkSecret(secret.value, requests),
    );
  });

  return { status, review, confirm };
}
