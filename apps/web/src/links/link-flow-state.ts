import type {
  ConfirmPaymentLinkOutcome,
  PaymentLinkCreated,
  PaymentLinkIntent,
  ResolvePaymentLinkOutcome,
  ReviewPaymentLinkOutcome,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import type { Answer } from "@/send/use-wallet-task";

import {
  type Delivery,
  LinkStep,
  delivered,
  entering,
  lost,
} from "./link-step";
import type { ShareResult } from "./share-link";

export interface LinkFlowState {
  readonly amount: string;
  readonly step: LinkStep;
}

export type LinkEvent = Data.TaggedEnum<{
  Typed: { readonly amount: string };
  Invalid: { readonly problem: string };
  ReviewStarted: { readonly intent: PaymentLinkIntent };
  ReviewAnswered: { readonly answer: Answer<ReviewPaymentLinkOutcome> };
  Edited: {};
  CreateStarted: {};
  CreateAnswered: { readonly answer: Answer<ConfirmPaymentLinkOutcome> };
  ShareStarted: {};
  ShareEnded: { readonly result: ShareResult };
  Left: {};
  CheckStarted: {};
  CheckAnswered: { readonly answer: Answer<ResolvePaymentLinkOutcome> };
}>;

export const LinkEvent = Data.taggedEnum<LinkEvent>();

const afterShare = (
  link: PaymentLinkCreated,
  delivery: Delivery,
  result: ShareResult,
): LinkStep => {
  if (delivered(delivery))
    return LinkStep.Created({
      link,
      delivery: result === "shared" || result === "copied" ? result : delivery,
    });

  return result === "unavailable"
    ? lost(link)
    : LinkStep.Created({ link, delivery: result });
};

const expired =
  "El link anterior venció y lo preparamos de nuevo. Revísalo y confirma otra vez.";

const afterCreate = (
  step: Data.TaggedEnum.Value<LinkStep, "Creating">,
  answer: Answer<ConfirmPaymentLinkOutcome>,
): LinkStep => {
  const withheld = (problem: string) =>
    LinkStep.Reviewed({
      intent: step.intent,
      review: step.review,
      problem: Option.some(problem),
    });

  return Match.value(answer).pipe(
    Match.tag("PaymentLinkCreated", (link) =>
      LinkStep.Created({ link, delivery: "none" }),
    ),
    Match.tag("PaymentReview", (review) =>
      LinkStep.Reviewed({
        intent: step.intent,
        review,
        problem: Option.some(expired),
      }),
    ),
    Match.tag("PasskeyCancelled", () =>
      withheld("No usaste tu passkey, así que no creamos el link."),
    ),
    Match.tag("PasskeyFailed", () =>
      withheld(
        "No pudimos usar tu passkey y no creamos el link. Inténtalo de nuevo.",
      ),
    ),
    Match.tag("WrongCredential", () =>
      withheld(
        "Usaste una passkey distinta y no creamos el link. Confirma con la passkey de tu cuenta.",
      ),
    ),
    Match.tag("AssertionRejected", () =>
      withheld(
        "No pudimos verificar tu passkey y no creamos el link. Confirma con tu huella, rostro o PIN del dispositivo.",
      ),
    ),
    Match.orElse((outcome) =>
      LinkStep.Refused({ intent: step.intent, confirmed: true, outcome }),
    ),
  );
};

export const reduceLinkFlow = (
  state: LinkFlowState,
  event: LinkEvent,
): LinkFlowState => {
  const { step } = state;
  const to = (next: LinkStep): LinkFlowState => ({ ...state, step: next });

  return Match.valueTags(event, {
    Typed: ({ amount }) =>
      Predicate.isTagged(step, "Entering")
        ? { amount, step: entering() }
        : state,
    Invalid: ({ problem }) =>
      Predicate.isTagged(step, "Entering")
        ? to(entering(Option.some(problem)))
        : state,
    ReviewStarted: ({ intent }) =>
      Predicate.isTagged(step, "Entering") ||
      Predicate.isTagged(step, "Refused")
        ? to(LinkStep.Reviewing({ intent }))
        : state,
    ReviewAnswered: ({ answer }) => {
      if (!Predicate.isTagged(step, "Reviewing")) return state;

      return to(
        Predicate.isTagged(answer, "PaymentReview")
          ? LinkStep.Reviewed({
              intent: step.intent,
              review: answer,
              problem: Option.none(),
            })
          : LinkStep.Refused({
              intent: step.intent,
              confirmed: false,
              outcome: answer,
            }),
      );
    },
    Edited: () =>
      Predicate.isTagged(step, "Reviewed") ||
      Predicate.isTagged(step, "Refused")
        ? to(entering())
        : state,
    CreateStarted: () =>
      Predicate.isTagged(step, "Reviewed")
        ? to(LinkStep.Creating({ intent: step.intent, review: step.review }))
        : state,
    CreateAnswered: ({ answer }) =>
      Predicate.isTagged(step, "Creating")
        ? to(afterCreate(step, answer))
        : state,
    ShareStarted: () =>
      Predicate.isTagged(step, "Created")
        ? to(LinkStep.Sharing({ link: step.link, delivery: step.delivery }))
        : state,
    ShareEnded: ({ result }) =>
      Predicate.isTagged(step, "Sharing")
        ? to(afterShare(step.link, step.delivery, result))
        : state,
    Left: () =>
      Predicate.isTagged(step, "Created") && !delivered(step.delivery)
        ? to(lost(step.link))
        : state,
    CheckStarted: () =>
      Predicate.isTagged(step, "Refused") || Predicate.isTagged(step, "Checked")
        ? to(LinkStep.Checking())
        : state,
    CheckAnswered: ({ answer }) => {
      if (!Predicate.isTagged(step, "Checking")) return state;

      return to(
        Predicate.isTagged(answer, "ResolvedPaymentLink")
          ? lost(answer)
          : LinkStep.Checked({ outcome: answer }),
      );
    },
  });
};

export const holdsUnsharedLink = (step: LinkStep) =>
  Match.valueTags(step, {
    Entering: () => false,
    Reviewing: () => false,
    Reviewed: () => false,
    Creating: () => true,
    Refused: () => false,
    Created: ({ delivery }) => !delivered(delivery),
    Sharing: ({ delivery }) => !delivered(delivery),
    Sent: () => false,
    Lost: () => false,
    Checking: () => false,
    Checked: () => false,
  });
