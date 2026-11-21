import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  AssetUnsupported,
  ClaimableLimitReached,
  ExternalRecipient,
  LinkRecipient,
  RecipientCannotReceive,
  type ResolvedRecipient,
  type TransferOrder,
  assetKey,
} from "../contract";
import { baseAccountOf } from "../stellar/destination";
import { claimableQuota } from "../stellar/network";
import { Chain } from "./Chain.server";
import type { Holdings } from "./ledger-assets.server";
import { rpcReadConcurrency } from "./settings.server";
import { Transfers } from "./Transfers.server";

export const paymentLinkAssetRefusal = Effect.gen(function* () {
  const chain = yield* Chain;

  return Effect.fn("Wallet.paymentLinkAssetRefusal")(function* (
    order: TransferOrder,
    senderHoldings?: Holdings,
  ) {
    if (!Predicate.isTagged(order.asset, "Issued"))
      return Option.none<AssetUnsupported>();

    const issued = order.asset;

    const [holdings, issuer] = yield* Effect.all(
      [
        senderHoldings === undefined
          ? chain.holdings(order.from, [issued])
          : Effect.succeed(Option.some(senderHoldings)),
        chain.issuer(issued),
      ],
      { concurrency: rpcReadConcurrency },
    );

    const sourceLine = Option.flatMap(holdings, (state) =>
      Option.fromNullishOr(
        state.lines.find((line) => assetKey(line.asset) === assetKey(issued)),
      ),
    );

    if (Option.isSome(sourceLine) && sourceLine.value.clawbackEnabled)
      return Option.some(new AssetUnsupported({ reason: "clawback_enabled" }));

    if (Option.isNone(issuer))
      return Option.some(new AssetUnsupported({ reason: "issuer_missing" }));

    if (issuer.value.authRequired)
      return Option.some(
        new AssetUnsupported({ reason: "authorization_required" }),
      );

    return Option.none<AssetUnsupported>();
  });
});

export const deliveryFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const transfers = yield* Transfers;
  const checkLinkAsset = yield* paymentLinkAssetRefusal;

  return Effect.fn("Wallet.delivery")(function* (
    order: TransferOrder,
    recipient: ResolvedRecipient,
    senderHoldings?: Holdings,
  ) {
    if (recipient instanceof LinkRecipient) {
      const refusal = yield* checkLinkAsset(order, senderHoldings);

      if (Option.isSome(refusal)) return refusal.value;

      if (
        (yield* transfers.openClaimables(order.from, "paymentLink")) >=
        claimableQuota.paymentLink
      )
        return new ClaimableLimitReached({ limit: claimableQuota.paymentLink });

      return yield* chain.draftPaymentLink(
        order.from,
        recipient.address,
        order.asset,
        order.amount,
      );
    }

    const assets = Match.valueTags(order.asset, {
      Native: () => [],
      Issued: (asset) => [asset],
    });

    const destination = yield* chain.holdings(
      baseAccountOf(recipient.address),
      assets,
    );

    const line = Option.flatMap(destination, (holdings) =>
      Option.fromNullishOr(holdings.lines[0]),
    );

    const reason = Option.isNone(destination)
      ? "no_account"
      : assets.length === 0
        ? undefined
        : Option.isNone(line)
          ? "no_trustline"
          : !line.value.authorized
            ? "not_authorized"
            : line.value.capacity < order.amount
              ? "no_capacity"
              : undefined;

    if (reason) {
      if (reason !== "no_trustline" || recipient instanceof ExternalRecipient)
        return new RecipientCannotReceive({
          address: baseAccountOf(recipient.address),
          reason,
        });

      if (
        (yield* transfers.openClaimables(order.from, "username")) >=
        claimableQuota.username
      )
        return new ClaimableLimitReached({ limit: claimableQuota.username });

      return yield* chain.draftClaimable(
        order.from,
        recipient.address,
        order.asset,
        order.amount,
      );
    }

    return yield* chain.draftPayment(
      order.from,
      recipient.address,
      order.asset,
      order.amount,
      order.memo,
    );
  });
});
