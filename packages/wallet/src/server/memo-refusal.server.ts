import * as Option from "effect/Option";
import {
  ExternalMemoRequired,
  ExternalRecipient,
  LinkRecipient,
  MemoNotAllowed,
  type ResolvedRecipient,
  type TransferOrder,
} from "../contract";
import { baseAccountOf, isMuxed } from "../stellar/destination";
import type { KnownExchangeMemo } from "./exchange-memos.server";

export const memoRefusal = (
  order: TransferOrder,
  recipient: ResolvedRecipient,
  requirement: Option.Option<KnownExchangeMemo>,
): Option.Option<ExternalMemoRequired | MemoNotAllowed> => {
  if (recipient instanceof LinkRecipient)
    return order.memo
      ? Option.some(new MemoNotAllowed({ reason: "payment_link" }))
      : Option.none();

  if (!(recipient instanceof ExternalRecipient))
    return order.memo
      ? Option.some(new MemoNotAllowed({ reason: "orchid" }))
      : Option.none();

  if (isMuxed(recipient.address))
    return order.memo
      ? Option.some(new MemoNotAllowed({ reason: "muxed" }))
      : Option.none();

  return Option.isSome(requirement) && !order.memo
    ? Option.some(
        new ExternalMemoRequired({
          address: baseAccountOf(recipient.address),
          exchange: requirement.value.exchange,
          source: requirement.value.source,
        }),
      )
    : Option.none();
};
