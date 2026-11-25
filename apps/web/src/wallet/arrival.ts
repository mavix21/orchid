import type {
  ClaimableBalance,
  DeviceOverview,
  Profile,
} from "@workspace/wallet";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { amountLabel } from "@/send/money";

export interface Arrival {
  readonly opening: boolean;
  readonly username: string;
  readonly payment: ClaimableBalance;
}

const arrivalFor = (
  profile: Profile,
  claimable: ReadonlyArray<ClaimableBalance>,
  opening: boolean,
): Option.Option<Arrival> =>
  Arr.findLast(claimable, (entry) => entry.to.address === profile.address).pipe(
    Option.map((payment) => ({
      opening,
      username: profile.username,
      payment,
    })),
  );

export const arrivalOf = (overview: DeviceOverview): Option.Option<Arrival> => {
  if (Predicate.isTagged(overview, "Holding"))
    return arrivalFor(overview.profile, overview.claimable, false);

  if (Predicate.isTagged(overview, "NotOpened"))
    return Option.flatMap(overview.profile, (profile) =>
      arrivalFor(profile, overview.claimable, true),
    );

  return Option.none();
};

export const arrivalSentence = ({ payment }: Arrival) =>
  `@${payment.from.username} te envió ${amountLabel(payment.amount, payment.asset)}`;
