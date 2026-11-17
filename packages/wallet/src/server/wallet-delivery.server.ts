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
import { maxOpenClaimables } from "../stellar/network";
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

    const destination = yield* chain.holdings(recipient.address, assets);

    const reason = Option.isNone(destination)
      ? "no_account"
      : assets.length && !destination.value.lines[0]
        ? "no_trustline"
        : assets.length && !destination.value.lines[0]?.authorized
          ? "not_authorized"
          : undefined;

    if (reason) {
      if (reason !== "no_trustline" || recipient instanceof ExternalRecipient)
        return new RecipientCannotReceive({
          address: recipient.address,
          reason,
        });

      if ((yield* transfers.openClaimables(order.from)) >= maxOpenClaimables)
        return new ClaimableLimitReached({ limit: maxOpenClaimables });

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
