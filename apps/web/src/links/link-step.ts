import type { PaymentLinkCreated, PaymentLinkIntent } from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

import {
  type CheckRefusal,
  type CreateRefusal,
  type RecoverableLink,
  recoverable,
} from "./outcomes";

export type Delivery = "none" | "dismissed" | "shared" | "copied";

export type LinkStep = Data.TaggedEnum<{
  Entering: { readonly problem: Option.Option<string> };
  Reviewing: { readonly intent: PaymentLinkIntent };
  Creating: { readonly intent: PaymentLinkIntent };
  Refused: {
    readonly intent: PaymentLinkIntent;
    readonly outcome: CreateRefusal;
  };
  Created: { readonly link: PaymentLinkCreated; readonly delivery: Delivery };
  Sharing: { readonly link: PaymentLinkCreated; readonly delivery: Delivery };
  Sent: { readonly link: RecoverableLink; readonly delivery: Delivery };
  Lost: { readonly link: RecoverableLink };
  Checking: {};
  Checked: { readonly outcome: CheckRefusal };
}>;

export const LinkStep = Data.taggedEnum<LinkStep>();

export const delivered = (delivery: Delivery) =>
  delivery === "shared" || delivery === "copied";

export const entering = (problem: Option.Option<string> = Option.none()) =>
  LinkStep.Entering({ problem });

export const lost = (link: RecoverableLink) =>
  LinkStep.Lost({ link: recoverable(link) });

export const concealedStep = (step: LinkStep): Option.Option<LinkStep> =>
  Match.valueTags(step, {
    Entering: () => Option.none(),
    Reviewing: () => Option.none(),
    Creating: () => Option.none(),
    Refused: () => Option.none(),
    Created: ({ link, delivery }) =>
      Option.some(
        delivered(delivery)
          ? LinkStep.Sent({ link: recoverable(link), delivery })
          : lost(link),
      ),
    Sharing: ({ link, delivery }) =>
      Option.some(
        delivered(delivery)
          ? LinkStep.Sent({ link: recoverable(link), delivery })
          : lost(link),
      ),
    Sent: () => Option.some(step),
    Lost: () => Option.some(step),
    Checking: () => Option.none(),
    Checked: () => Option.none(),
  });
