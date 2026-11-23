import {
  Account,
  type Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type Asset,
  type BalanceId,
  type PositiveAmount,
  SigningRequest,
} from "../contract";
import { draftLinkCleanup, draftLinkReceive } from "../stellar/link-receive";
import {
  baseFee,
  networkPassphrase,
  paymentLifetime,
} from "../stellar/network";
import type { ChainUnreachable } from "./chain-errors.server";
import type { AccountState } from "./ledger.server";

export interface LinkChain {
  readonly channel: AccountAddress;
  draftLinkReceive(
    link: AccountAddress,
    destination: AccountAddress,
    balance: BalanceId,
    asset: Asset,
    amount: PositiveAmount,
  ): Effect.Effect<SigningRequest, ChainUnreachable>;
  cleanUpLink(link: AccountAddress): Effect.Effect<boolean, ChainUnreachable>;
}

export const linkChain = (
  sponsor: Keypair,
  feePayer: Keypair,
  account: (
    address: AccountAddress,
  ) => Effect.Effect<Option.Option<AccountState>, ChainUnreachable>,
  source: (address: AccountAddress) => Effect.Effect<Account, ChainUnreachable>,
  send: (envelope: string) => Effect.Effect<void>,
): LinkChain => {
  const reserveSponsor = Schema.decodeSync(AccountAddress)(sponsor.publicKey());
  const channel = Schema.decodeSync(AccountAddress)(feePayer.publicKey());

  const lifetime = Effect.map(Clock.currentTimeMillis, (now) => {
    const minTime = Math.floor(now / 1000);

    return { minTime, maxTime: minTime + paymentLifetime };
  });

  return {
    channel,
    draftLinkReceive: Effect.fn("Chain.draftLinkReceive")(function* (
      link: AccountAddress,
      destination: AccountAddress,
      balance: BalanceId,
      asset: Asset,
      amount: PositiveAmount,
    ) {
      const { minTime, maxTime } = yield* lifetime;

      return new SigningRequest({
        envelope: draftLinkReceive({
          channel: yield* source(channel),
          link,
          reserveSponsor,
          destination,
          balance,
          asset,
          amount,
          minTime,
          maxTime,
        }),
        expiresAt: DateTime.makeUnsafe(maxTime * 1000),
      });
    }),
    cleanUpLink: Effect.fn("Chain.cleanUpLink")(function* (
      link: AccountAddress,
    ) {
      const state = yield* account(link);

      if (Option.isNone(state)) return true;

      const { maxTime } = yield* lifetime;

      const merge = draftLinkCleanup(
        new Account(link, state.value.sequence),
        reserveSponsor,
        maxTime,
      );

      merge.sign(sponsor);

      const outer = TransactionBuilder.buildFeeBumpTransaction(
        feePayer.publicKey(),
        baseFee,
        merge,
        networkPassphrase,
      );

      outer.sign(feePayer);

      yield* send(outer.toXDR());

      return false;
    }),
  };
};
