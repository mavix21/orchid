import { useEffect, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import type {
  ConfirmReclaimOutcome,
  ReviewReclaimOutcome,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";

import { walletEffects } from "@/wallet";
import { type Arrival, arrivalSentence } from "@/wallet/arrival";
import { DeviceFailure, useWalletTask } from "@/send/use-wallet-task";

type WaitingStep = Data.TaggedEnum<{
  Claiming: {};
  Stopped: { readonly problem: string };
}>;

const WaitingStep = Data.taggedEnum<WaitingStep>();

const stopped = (outcome: ConfirmReclaimOutcome | DeviceFailure) =>
  WaitingStep.Stopped({
    problem: Predicate.isTagged(outcome, "AssetPending")
      ? "La red todavía está confirmando tu pago. Revisa en unos segundos."
      : Predicate.isTagged(outcome, "PasskeyCancelled")
        ? "No usaste tu passkey, así que el pago sigue esperando."
        : "No pudimos recibir el pago. Inténtalo de nuevo.",
  });

export function WaitingPayment({
  arrival,
  onReceived,
}: {
  arrival: Arrival;
  onReceived: () => void;
}) {
  const task = useWalletTask();
  const [step, setStep] = useState<WaitingStep>(WaitingStep.Claiming());
  const { payment } = arrival;

  const settle = (outcome: ConfirmReclaimOutcome | DeviceFailure) => {
    if (
      Predicate.isTagged(outcome, "AssetSettled") ||
      Predicate.isTagged(outcome, "HeldFundsGone")
    )
      onReceived();
    else setStep(stopped(outcome));
  };

  const confirm = (
    review: Extract<ReviewReclaimOutcome, { _tag: "ReclaimReview" }>,
  ) => task.run(walletEffects.confirmReclaim(review), settle);

  const claim = () => {
    setStep(WaitingStep.Claiming());
    task.run(
      walletEffects.reviewReclaim({
        heldFunds: payment.id,
        asset: payment.asset,
        amount: payment.amount,
      }),
      (answer) =>
        !(answer instanceof DeviceFailure) &&
        Predicate.isTagged(answer, "ReclaimReview")
          ? confirm(answer)
          : settle(answer),
    );
  };

  useEffect(claim, [payment.id]);

  return (
    <section
      aria-labelledby="waiting-payment-title"
      data-testid="waiting-payment"
      className="flex flex-col gap-3 rounded-lg bg-muted p-4"
    >
      <h2 id="waiting-payment-title" className="text-label-lg">
        {arrivalSentence(arrival)}
      </h2>
      {Match.valueTags(step, {
        Claiming: () => (
          <p role="status" className="text-body text-muted-foreground">
            Recibiendo tu pago…
          </p>
        ),
        Stopped: ({ problem }) => (
          <>
            <p role="alert" className="text-body text-destructive">
              {problem}
            </p>
            <Button className="w-full" onClick={claim}>
              Recibir con passkey
            </Button>
          </>
        ),
      })}
    </section>
  );
}
