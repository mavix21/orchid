import { useEffect, useRef, useState } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  type Amount,
  type Asset,
  type PaymentReview,
  type Receipt,
  type ReviewOutcome,
  type ResumeOutcome,
  type TransferId,
  TransferIntent,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { ScreenActions } from "@/components/screen";

import {
  FieldProblem,
  type SendField,
  type SendForm,
  intentOf,
  sendsToAddress,
} from "./intent";
import { amountLabel } from "./money";
import { SendScreen, sendResult } from "./outcomes";
import { PaymentReviewCard } from "./payment-review";
import { SendResultScreen } from "./send-result";

type Stage = Data.TaggedEnum<{
  Entering: {};
  Working: { readonly label: string };
  Reviewing: { readonly review: PaymentReview };
  Finished: { readonly screen: SendScreen };
}>;

const Stage = Data.taggedEnum<Stage>();

const emptyForm: SendForm = { recipient: "", amount: "", memo: "" };

const intentFromReview = (review: PaymentReview) =>
  new TransferIntent({
    to: review.order.to,
    asset: review.order.asset,
    amount: review.order.amount,
    memo: review.order.memo,
  });

export function SendFlow({
  asset,
  available,
  transfer,
  onTransfer,
}: {
  asset: Asset;
  available: Amount;
  transfer: Option.Option<TransferId>;
  onTransfer: (id: Option.Option<TransferId>) => void;
}) {
  const { walletClient } = useRouteContext({ from: "__root__" });

  const [stage, setStage] = useState<Stage>(() =>
    Option.isSome(transfer)
      ? Stage.Working({ label: "Buscando tu pago…" })
      : Stage.Entering(),
  );

  const [form, setForm] = useState<SendForm>(emptyForm);

  const [problem, setProblem] = useState<Option.Option<FieldProblem>>(
    Option.none(),
  );

  const again = useRef<() => Promise<void>>(async () => {
    setStage(Stage.Entering());
  });

  const fields = useRef<Partial<Record<SendField, HTMLInputElement | null>>>(
    {},
  );

  const settle = (outcome: ReviewOutcome | ResumeOutcome | Receipt) =>
    Match.value(outcome).pipe(
      Match.tag("PaymentReview", (review) =>
        setStage(Stage.Reviewing({ review })),
      ),
      Match.orElse((answered) => {
        const result = sendResult(answered, asset);

        if (result instanceof FieldProblem) {
          setProblem(Option.some(result));
          setStage(Stage.Entering());
          onTransfer(Option.none());

          return;
        }

        setStage(Stage.Finished({ screen: result }));
      }),
    );

  const review = async (intent: TransferIntent) => {
    again.current = () => review(intent);
    setStage(Stage.Working({ label: "Preparando tu pago…" }));
    settle(await walletClient.review(intent));
  };

  const confirm = async (shown: PaymentReview) => {
    again.current = () => review(intentFromReview(shown));
    onTransfer(Option.some(shown.order.id));
    setStage(Stage.Working({ label: "Enviando…" }));
    settle(await walletClient.confirm(shown));
  };

  const resume = async (id: TransferId) => {
    again.current = () => resume(id);
    setStage(Stage.Working({ label: "Buscando tu pago…" }));

    const resumed = await walletClient.resume(id);

    if (!Predicate.isTagged(resumed, "NoTransfer")) return settle(resumed);

    const overview = await walletClient.overview();

    const latest = Predicate.isTagged(overview, "Holding")
      ? overview.latest.pipe(Option.filter((receipt) => receipt.id === id))
      : Option.none();

    settle(Option.getOrElse(latest, () => resumed));
  };

  useEffect(() => {
    if (Option.isSome(transfer)) void resume(transfer.value);
  }, []);

  useEffect(() => {
    if (Option.isSome(problem)) fields.current[problem.value.field]?.focus();
  }, [problem]);

  const edit = (field: SendField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setProblem(Option.none());
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    Result.match(intentOf(form, asset), {
      onFailure: (refused) => setProblem(Option.some(refused)),
      onSuccess: (intent) => void review(intent),
    });
  };

  const messageFor = (field: SendField) =>
    problem.pipe(
      Option.filter((found) => found.field === field),
      Option.map((found) => found.message),
    );

  const fieldInput = (field: SendField, label: string, hint?: string) => {
    const message = messageFor(field);

    return (
      <Field>
        <FieldLabel htmlFor={field}>{label}</FieldLabel>
        <Input
          id={field}
          name={field}
          ref={(element) => {
            fields.current[field] = element;
          }}
          value={form[field]}
          onChange={(event) => edit(field, event.target.value)}
          inputMode={field === "amount" ? "decimal" : undefined}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={Option.isSome(message) ? true : undefined}
          aria-describedby={
            Option.isSome(message) ? `${field}-error` : undefined
          }
        />
        {hint === undefined ? null : (
          <FieldDescription>{hint}</FieldDescription>
        )}
        {Option.isSome(message) ? (
          <FieldError id={`${field}-error`}>{message.value}</FieldError>
        ) : null}
      </Field>
    );
  };

  const memoRefused = Option.exists(
    problem,
    (found) => found.field === "memo" && form.memo !== "",
  );

  return Stage.$match(stage, {
    Entering: () => (
      <form className="flex flex-1 flex-col" noValidate onSubmit={submit}>
        <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
          <h1 className="font-display text-h1">¿A quién le envías?</h1>
          {fieldInput("recipient", "Para", "Un @usuario o una dirección G…")}
          {fieldInput(
            "amount",
            "Monto",
            `Disponible: ${amountLabel(available, asset)}`,
          )}
          {sendsToAddress(form.recipient)
            ? fieldInput(
                "memo",
                "Memo",
                "Solo si el destino lo pide, como un exchange",
              )
            : null}
          {memoRefused ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => edit("memo", "")}
            >
              Quitar memo
            </Button>
          ) : null}
        </main>
        <ScreenActions>
          <Button className="w-full" type="submit">
            Revisar
          </Button>
        </ScreenActions>
      </form>
    ),
    Working: ({ label }) => (
      <main
        role="status"
        className="flex flex-1 flex-col justify-end gap-2 px-5 pb-30"
      >
        <h1 className="font-display text-h1">{label}</h1>
      </main>
    ),
    Reviewing: ({ review: shown }) => (
      <>
        <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
          <h1 className="font-display text-h1">Revisa tu pago</h1>
          <PaymentReviewCard review={shown} />
        </main>
        <ScreenActions>
          <Button className="w-full" onClick={() => void confirm(shown)}>
            Enviar
          </Button>
          <Button
            className="w-full"
            variant="secondary"
            onClick={() => setStage(Stage.Entering())}
          >
            Editar
          </Button>
        </ScreenActions>
      </>
    ),
    Finished: ({ screen }) => (
      <SendResultScreen screen={screen} onAgain={() => void again.current()} />
    ),
  });
}
