import { type Asset, assetKey } from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { type LinkStep, concealedStep } from "./link-step";

let kept: Option.Option<LinkStep> = Option.none();

export const keepConcealed = (step: LinkStep) => {
  kept = concealedStep(step);
};

export const concealedLinkFor = (asset: Asset): Option.Option<LinkStep> =>
  Option.filter(
    kept,
    (step) =>
      (Predicate.isTagged(step, "Lost") ||
        Predicate.isTagged(step, "Saved") ||
        Predicate.isTagged(step, "Sent")) &&
      assetKey(step.link.asset) === assetKey(asset),
  );

export const forgetConcealed = () => {
  kept = Option.none();
};
