import * as Option from "effect/Option";

import { type LinkStep, concealedStep } from "./link-step";

let kept: Option.Option<LinkStep> = Option.none();

export const keepConcealed = (step: LinkStep) => {
  kept = concealedStep(step);
};

export const concealedLink = () => kept;

export const forgetConcealed = () => {
  kept = Option.none();
};
