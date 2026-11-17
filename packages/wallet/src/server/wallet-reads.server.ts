import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AccountAddress, SigningRequest } from "../contract";
import { approvalMargin } from "../stellar/network";
import { Chain } from "./Chain.server";

/** A draft can still be approved: enough time remains before its upper time bound. */
export const live = (request: SigningRequest) =>
  DateTime.toEpochMillis(request.expiresAt) >
  Date.now() + approvalMargin * 1000;

/** Account reads that confirm a negative observation before reporting it. */
export const confirmedReads = Effect.gen(function* () {
  const chain = yield* Chain;

  // A single negative observation is not enough to destroy durable state.
  const readAccount = Effect.fn("Wallet.readAccount")(function* (
    address: AccountAddress,
  ) {
    const first = yield* chain.account(address);

    return Option.isNone(first) || Option.isNone(first.value.balance)
      ? yield* chain.account(address)
      : first;
  });

  const readBalance = (address: AccountAddress) =>
    readAccount(address).pipe(
      Effect.map(Option.flatMap((state) => state.balance)),
    );

  return { readAccount, readBalance };
});
