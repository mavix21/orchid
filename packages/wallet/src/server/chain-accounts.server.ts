import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AccountAddress, Amount } from "../contract";
import type { ChainUnreachable } from "./chain-errors.server";
import type { AccountState } from "./ledger.server";

export type AccountStanding = "absent" | "incomplete" | "open" | "foreign";

export interface AccountChain {
  standing(
    address: AccountAddress,
  ): Effect.Effect<AccountStanding, ChainUnreachable>;
  balance(
    address: AccountAddress,
  ): Effect.Effect<Option.Option<Amount>, ChainUnreachable>;
}

const standingOf = (state: AccountState): AccountStanding => {
  const holdsBaseAsset = Option.isSome(state.balance);

  if (!state.accountSponsored || (holdsBaseAsset && !state.sponsored))
    return "foreign";

  return holdsBaseAsset ? "open" : "incomplete";
};

export const accountChain = (
  account: (
    address: AccountAddress,
  ) => Effect.Effect<Option.Option<AccountState>, ChainUnreachable>,
): AccountChain => ({
  standing: (address) =>
    account(address).pipe(
      Effect.map(
        Option.match({
          onNone: (): AccountStanding => "absent",
          onSome: standingOf,
        }),
      ),
    ),
  balance: (address) =>
    account(address).pipe(Effect.map(Option.flatMap((state) => state.balance))),
});
