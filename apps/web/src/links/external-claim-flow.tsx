import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import {
  type AccountAddress,
  type ExternalLinkIntent,
  type ExternalLinkReview,
  type PaymentLinkOpen,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { BloomHero } from "@/components/orchid-bloom";
import { ReviewHero } from "@/components/review-hero";
import { Screen, ScreenActions } from "@/components/screen";
import {
  LinkResultScreen,
  LinkWorking,
  ResultButton,
  ResultLink,
} from "@/links/link-result";
import type { LinkScreen } from "@/links/outcomes";
import { FullValue } from "@/links/recovery";
import { memoByteLimit, memoBytes } from "@/send/intent";
import { amountLabel } from "@/send/money";
import { ReviewRow } from "@/send/payment-review";
import { useWalletTask } from "@/send/use-wallet-task";
import { walletEffects } from "@/wallet";

import {
  type ExternalClaimFieldProblem,
  type ExternalClaimForm,
  externalClaimIntentOf,
  isMuxedDestination,
} from "./external-claim-intent";
import {
  type ExternalClaimAction,
  ExternalClaimResult,
  confirmExternalResult,
  reviewExternalResult,
} from "./external-claim-outcomes";

type ExternalStep = Data.TaggedEnum<{
  Form: {
    readonly problem: Option.Option<ExternalClaimFieldProblem>;
    readonly lookupError: Option.Option<string>;
  };
  Preparing: {};
  Reviewing: {
    readonly review: ExternalLinkReview;
    readonly notice: Option.Option<string>;
  };
  Confirming: { readonly review: ExternalLinkReview };
  Concluded: {
    readonly outcome: string;
    readonly screen: LinkScreen<ExternalClaimAction>;
  };
}>;

const ExternalStep = Data.taggedEnum<ExternalStep>();

export function ExternalClaimFlow({
  link,
  open,
  fragment,
  onBack,
  onRecheck,
}: {
  link: AccountAddress;
  open: PaymentLinkOpen;
  fragment: () => string;
  onBack: () => void;
  onRecheck: () => void;
}) {
  const task = useWalletTask();
  const destinationRef = useRef<HTMLInputElement>(null);
  const memoRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<ExternalClaimForm>({
    destination: "",
    memo: "",
  });

  const [step, setStep] = useState<ExternalStep>(
    ExternalStep.Form({ problem: Option.none(), lookupError: Option.none() }),
  );

  const sent = amountLabel(open.amount, open.asset);
  const muxed = isMuxedDestination(form.destination);

  useEffect(() => {
    if (!Predicate.isTagged(step, "Form") || Option.isNone(step.problem))
      return;

    if (step.problem.value.field === "destination")
      destinationRef.current?.focus();
    else memoRef.current?.focus();
  }, [step]);

  const applyResult = (result: ExternalClaimResult) =>
    setStep(
      Match.valueTags(result, {
        Field: ({ problem }) =>
          ExternalStep.Form({
            problem: Option.some(problem),
            lookupError: Option.none(),
          }),
        RetryLookup: ({ message }) =>
          ExternalStep.Form({
            problem: Option.none(),
            lookupError: Option.some(message),
          }),
        Concluded: ({ outcome, screen }) =>
          ExternalStep.Concluded({ outcome, screen }),
      }),
    );

  const startReview = (intent: ExternalLinkIntent) => {
    setStep(ExternalStep.Preparing());
    task.run(
      walletEffects.reviewExternalLinkClaim(link, fragment(), intent),
      (answer) => {
        if (Predicate.isTagged(answer, "ExternalLinkReview")) {
          setStep(
            ExternalStep.Reviewing({ review: answer, notice: Option.none() }),
          );

          return;
        }

        applyResult(reviewExternalResult(answer, open.asset));
      },
    );
  };

  const submitForm = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    Result.match(externalClaimIntentOf(form), {
      onFailure: (problem) =>
        applyResult(ExternalClaimResult.Field({ problem })),
      onSuccess: startReview,
    });
  };

  const confirm = (shown: ExternalLinkReview) => {
    setStep(ExternalStep.Confirming({ review: shown }));
    task.run(
      walletEffects.confirmExternalLinkClaim(shown, fragment()),
      (answer) => {
        if (Predicate.isTagged(answer, "ExternalLinkReview")) {
          setStep(
            ExternalStep.Reviewing({
              review: answer,
              notice: Option.some(
                "El envío anterior venció y lo preparamos de nuevo. Revísalo y confirma otra vez.",
              ),
            }),
          );

          return;
        }

        applyResult(
          confirmExternalResult(answer, open.asset, sent, shown.destination),
        );
      },
    );
  };

  return Match.valueTags(step, {
    Form: ({ problem, lookupError }) => {
      const destinationProblem = problem.pipe(
        Option.filter((found) => found.field === "destination"),
        Option.map((found) => found.message),
      );

      const memoProblem = problem.pipe(
        Option.filter((found) => found.field === "memo"),
        Option.map((found) => found.message),
      );

      return (
        <Screen>
          <form
            className="flex flex-1 flex-col"
            noValidate
            onSubmit={submitForm}
          >
            <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
              <div className="flex flex-col gap-1">
                <h1 className="font-display text-h1">
                  Enviar a otra dirección
                </h1>
                <p className="text-body text-muted-foreground">
                  {sent} de @{open.sender.username}
                </p>
              </div>
              <Field>
                <FieldLabel htmlFor="external-destination">
                  Dirección Stellar
                </FieldLabel>
                <Input
                  id="external-destination"
                  name="destination"
                  ref={destinationRef}
                  value={form.destination}
                  onChange={(event) => {
                    setForm((current) => ({
                      ...current,
                      destination: event.target.value,
                    }));
                    setStep(
                      ExternalStep.Form({
                        problem: Option.none(),
                        lookupError: Option.none(),
                      }),
                    );
                  }}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus={Option.isNone(memoProblem)}
                  aria-invalid={Option.isSome(destinationProblem) || undefined}
                  aria-describedby={
                    Option.isSome(destinationProblem)
                      ? "external-destination-error"
                      : undefined
                  }
                />
                <FieldDescription>Empieza con G o M</FieldDescription>
                {Option.isSome(destinationProblem) ? (
                  <FieldError id="external-destination-error">
                    {destinationProblem.value}
                  </FieldError>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="external-memo">Memo (opcional)</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="external-memo"
                    name="memo"
                    ref={memoRef}
                    value={muxed ? "" : form.memo}
                    disabled={muxed}
                    onChange={(event) => {
                      setForm((current) => ({
                        ...current,
                        memo: event.target.value,
                      }));
                      setStep(
                        ExternalStep.Form({
                          problem: Option.none(),
                          lookupError: Option.none(),
                        }),
                      );
                    }}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={Option.isSome(memoProblem) || undefined}
                    aria-describedby={
                      Option.isSome(memoProblem)
                        ? "external-memo-error"
                        : undefined
                    }
                  />
                  {muxed ? null : (
                    <InputGroupAddon align="inline-end">
                      <span className="text-label tabular-nums">
                        {memoBytes(form.memo)}/{memoByteLimit}
                      </span>
                    </InputGroupAddon>
                  )}
                </InputGroup>
                <FieldDescription>
                  {muxed
                    ? "Esta dirección ya identifica tu cuenta; no necesita memo."
                    : "Si la app que recibe te dio un memo, pégalo aquí."}
                </FieldDescription>
                {Option.isSome(memoProblem) ? (
                  <FieldError id="external-memo-error">
                    {memoProblem.value}
                  </FieldError>
                ) : null}
              </Field>
              {Option.isSome(lookupError) ? (
                <p
                  role="alert"
                  data-testid="external-lookup-error"
                  className="text-body text-destructive"
                >
                  {lookupError.value}
                </p>
              ) : null}
            </main>
            <ScreenActions>
              <Button
                className="w-full"
                type="submit"
                data-testid={
                  Option.isSome(lookupError)
                    ? "retry-external-claim"
                    : "review-external-claim"
                }
              >
                {Option.isSome(lookupError) ? "Reintentar" : "Revisar"}
              </Button>
              <Button
                className="w-full"
                type="button"
                variant="secondary"
                data-testid="back-to-offer"
                onClick={onBack}
              >
                Volver
              </Button>
            </ScreenActions>
          </form>
        </Screen>
      );
    },
    Preparing: () => (
      <Screen>
        <LinkWorking label="Preparando tu envío…" />
      </Screen>
    ),
    Reviewing: ({ review: shown, notice }) => (
      <Screen>
        <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
          <ReviewHero
            title={`De @${shown.sender.username}`}
            amount={amountLabel(shown.amount, shown.asset)}
            network={shown.network}
          />
          <dl
            aria-label="Resumen del envío"
            data-testid="external-claim-review"
            className="flex flex-col divide-y divide-border rounded-lg border border-border px-4"
          >
            <ReviewRow label="Para">
              <span className="flex flex-col items-end">
                <FullValue>{shown.destination}</FullValue>
                {shown.memoRequired ? (
                  <span className="text-caption text-muted-foreground">
                    Esta dirección requiere memo
                  </span>
                ) : null}
              </span>
            </ReviewRow>
            {shown.memo === undefined ? null : (
              <ReviewRow label="Memo">
                <span className="break-all whitespace-pre-wrap">
                  {shown.memo.value}
                </span>
              </ReviewRow>
            )}
            <ReviewRow label="Comisión">Gratis</ReviewRow>
          </dl>
          <p className="text-body text-muted-foreground">
            El link deja de funcionar y el dinero va a esa dirección.
          </p>
          {Option.isSome(notice) ? (
            <p role="alert" className="text-body text-destructive">
              {notice.value}
            </p>
          ) : null}
        </main>
        <ScreenActions>
          <Button
            className="w-full"
            data-testid="confirm-external-claim"
            onClick={() => confirm(shown)}
          >
            Enviar
          </Button>
          <Button
            className="w-full"
            type="button"
            variant="secondary"
            data-testid="edit-external-claim"
            onClick={() =>
              setStep(
                ExternalStep.Form({
                  problem: Option.none(),
                  lookupError: Option.none(),
                }),
              )
            }
          >
            Editar
          </Button>
        </ScreenActions>
      </Screen>
    ),
    Confirming: () => (
      <Screen>
        <LinkWorking label="Enviando…" />
      </Screen>
    ),
    Concluded: ({ outcome, screen }) =>
      outcome === "ExternalLinkSettled" ? (
        <Screen>
          <main
            data-testid="link-outcome"
            data-outcome={outcome}
            className="flex flex-1 flex-col px-5"
          >
            <BloomHero motion="flourish" label={screen.title}>
              <p className="text-body text-muted-foreground">
                {screen.message}
              </p>
            </BloomHero>
          </main>
          <ScreenActions>
            <ResultLink link={<Link to="/" />}>Ir al inicio</ResultLink>
          </ScreenActions>
        </Screen>
      ) : (
        <Screen>
          <LinkResultScreen outcome={outcome} screen={screen}>
            {Match.value(screen.action).pipe(
              Match.when("check", () => (
                <ResultButton onClick={onRecheck}>
                  Revisar de nuevo
                </ResultButton>
              )),
              Match.when("done", () => (
                <ResultLink link={<Link to="/" />}>Ir al inicio</ResultLink>
              )),
              Match.exhaustive,
            )}
          </LinkResultScreen>
        </Screen>
      ),
  });
}
