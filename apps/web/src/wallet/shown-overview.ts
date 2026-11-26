import { redirect } from "@tanstack/react-router";
import { type DeviceOverview, Holding } from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

export const shownOverview = Match.type<DeviceOverview>().pipe(
  Match.tag("NoWallet", () => {
    throw redirect({ to: "/", replace: true });
  }),
  Match.tag("NotOpened", ({ profile, heldFunds }) =>
    Option.match(profile, {
      onNone: () => {
        throw redirect({ to: "/create-account", replace: true });
      },
      onSome: (owner) =>
        new Holding({
          profile: owner,
          reserveSponsor: Option.none(),
          balances: [],
          heldFunds,
          latest: Option.none(),
        }),
    }),
  ),
  Match.orElse((overview) => overview),
);
