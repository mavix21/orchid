import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import {
  ClaimableLimitReached,
  ExternalRecipient,
  RecipientCannotReceive,
  type ResolvedRecipient,
  type TransferOrder,
} from "../contract";
import { baseAccountOf } from "../stellar/destination";
import { claimableQuota } from "../stellar/network";
import { Chain } from "./Chain.server";
import { Transfers } from "./Transfers.server";

export const deliveryFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const transfers = yield* Transfers;

  return Effect.fn("Wallet.delivery")(function* (
    order: TransferOrder,
    recipient: ResolvedRecipient,
  ) {
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
        (yield* transfers.openClaimables(order.from)) >= claimableQuota.username
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
