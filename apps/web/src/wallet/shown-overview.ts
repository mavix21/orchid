import { redirect } from "@tanstack/react-router";
import type { DeviceOverview } from "@workspace/wallet";
import * as Match from "effect/Match";

export const shownOverview = Match.type<DeviceOverview>().pipe(
  Match.tag("NoWallet", () => {
    throw redirect({ to: "/", replace: true });
  }),
  Match.tag("NotOpened", () => {
    throw redirect({ to: "/create-account", replace: true });
  }),
  Match.orElse((overview) => overview),
);
