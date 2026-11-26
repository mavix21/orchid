import type { HeldFunds, DeviceOverview, Profile } from "@workspace/wallet";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { amountLabel } from "@/send/money";
import { m } from "@/paraglide/messages";

export interface Arrival {
  readonly opening: boolean;
  readonly username: string;
  readonly payment: HeldFunds;
}

const arrivalFor = (
  profile: Profile,
  waiting: ReadonlyArray<HeldFunds>,
  opening: boolean,
): Option.Option<Arrival> =>
  Arr.findLast(waiting, (entry) => entry.to.address === profile.address).pipe(
    Option.map((payment) => ({
      opening,
      username: profile.username,
      payment,
    })),
  );

export const arrivalOf = (overview: DeviceOverview): Option.Option<Arrival> => {
  if (Predicate.isTagged(overview, "Holding"))
    return arrivalFor(overview.profile, overview.heldFunds, false);

  if (Predicate.isTagged(overview, "NotOpened"))
    return Option.flatMap(overview.profile, (profile) =>
      arrivalFor(profile, overview.heldFunds, true),
    );

  return Option.none();
};

export const arrivalSentence = ({ payment }: Arrival) =>
  m.arrival_sentence({
    username: payment.from.username,
    amount: amountLabel(payment.amount, payment.asset),
  });
