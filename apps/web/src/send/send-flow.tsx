import { PhoneIcon, UserRoundIcon, WalletIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import type {
  Amount,
  Asset,
  PaymentReview,
  ResumeOutcome,
  ReviewOutcome,
  TransferId,
  TransferIntent,
} from "@workspace/wallet";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { OptionRow } from "@/components/option-row";
import { ScreenActions } from "@/components/screen";
import { walletEffects } from "@/wallet";

import {
  type Destination,
  FieldProblem,
  type SendField,
  type SendForm,
  intentOf,
  memoByteLimit,
  memoBytes,
} from "./intent";
import { amountLabel } from "./money";
import { deviceFailure, sendResult } from "./outcomes";
import { PaymentReviewCard } from "./payment-review";
import { SendResultScreen } from "./send-result";
import { type WalletRun, useWalletRun } from "./use-wallet-run";

type Answer = WalletRun<ReviewOutcome | ResumeOutcome>;

const emptyForm: SendForm = { recipient: "", amount: "", memo: "" };

const settledValue = (answer: Answer) =>
  answer.working
    ? Option.none()
    : answer.answered.pipe(
        Option.filter(Exit.isSuccess),
        Option.map((exit) => exit.value),
      );

const fieldProblemOf = (answer: Answer, asset: Asset) =>
  Option.flatMap(settledValue(answer), (value) =>
    Match.value(value).pipe(
      Match.tag("PaymentReview", () => Option.none<FieldProblem>()),
      Match.orElse((outcome) => {
        const result = sendResult(outcome, asset);

        return result instanceof FieldProblem
          ? Option.some(result)
          : Option.none();
      }),
    ),
  );

function Working({ label }: { label: string }) {
  return (
    <main
      role="status"
      className="flex flex-1 flex-col justify-end gap-2 px-5 pb-30"
    >
      <h1 className="font-display text-h1">{label}</h1>
    </main>
  );
}

function AnswerScreen({
  answer,
  asset,
  working,
  onConfirm,
  onEdit,
  onAgain,
}: {
  answer: Answer;
  asset: Asset;
  working: string;
  onConfirm: (shown: PaymentReview) => void;
  onEdit: () => void;
  onAgain: () => void;
}) {
  if (answer.working || Option.isNone(answer.answered))
    return <Working label={working} />;

  return Exit.match(answer.answered.value, {
    onFailure: () => (
      <SendResultScreen screen={deviceFailure} onAgain={onAgain} />
    ),
    onSuccess: (value) =>
      Match.value(value).pipe(
        Match.tag("PaymentReview", (shown) => (
          <>
            <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
              <h1 className="font-display text-h1">Revisa tu pago</h1>
              <PaymentReviewCard review={shown} />
            </main>
            <ScreenActions>
              <Button className="w-full" onClick={() => onConfirm(shown)}>
                Enviar
              </Button>
              <Button className="w-full" variant="secondary" onClick={onEdit}>
                Editar
              </Button>
            </ScreenActions>
          </>
        )),
        Match.orElse((outcome) => {
          const result = sendResult(outcome, asset);

          return result instanceof FieldProblem ? (
            <Working label={working} />
          ) : (
            <SendResultScreen screen={result} onAgain={onAgain} />
          );
        }),
      ),
  });
}

function TransferStatus({
  id,
  asset,
  onStartOver,
}: {
  id: TransferId;
  asset: Asset;
  onStartOver: () => void;
}) {
  const lookup = useWalletRun(walletEffects.resume);

  useEffect(() => lookup.start(id), [id]);

  const failed = Option.exists(settledValue(lookup.state), (value) =>
    Predicate.isTagged(value, "Failed"),
  );

  return (
    <AnswerScreen
      answer={lookup.state}
      asset={asset}
      working="Buscando tu pago…"
      onConfirm={onStartOver}
      onEdit={onStartOver}
      onAgain={failed ? onStartOver : () => lookup.start(id)}
    />
  );
}

function DestinationChoice({
  onChoose,
}: {
  onChoose: (destination: Destination) => void;
}) {
  return (
    <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
      <h1 className="font-display text-h1">¿A dónde lo envías?</h1>
      <div className="flex flex-col gap-3">
        <OptionRow
          title="A un @usuario"
          description="Alguien que tenga Orchid"
          media={<UserRoundIcon />}
          render={<button type="button" onClick={() => onChoose("username")} />}
        />
        <OptionRow
          title="A una dirección Stellar"
          description="Otra wallet o un exchange"
          media={<WalletIcon />}
          render={<button type="button" onClick={() => onChoose("address")} />}
        />
        <OptionRow
          title="A un teléfono"
          description="Los envíos por teléfono llegan pronto"
          media={<PhoneIcon />}
          render={<button type="button" disabled />}
        />
      </div>
    </main>
  );
}

function SendFormStep({
  destination,
  form,
  problem,
  asset,
  available,
  onEdit,
  onIntent,
  onProblem,
  onChangeDestination,
}: {
  destination: Destination;
  form: SendForm;
  problem: Option.Option<FieldProblem>;
  asset: Asset;
  available: Amount;
  onEdit: (field: SendField, value: string) => void;
  onIntent: (intent: TransferIntent) => void;
  onProblem: (problem: FieldProblem) => void;
  onChangeDestination: () => void;
}) {
  const fields = useRef<Partial<Record<SendField, HTMLInputElement | null>>>(
    {},
  );

  useEffect(() => {
    if (Option.isSome(problem)) fields.current[problem.value.field]?.focus();
  }, [problem]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    Result.match(intentOf(form, destination, asset), {
      onFailure: onProblem,
      onSuccess: onIntent,
    });
  };

  const fieldInput = (
    field: SendField,
    label: string,
    hint: string,
    adornment: { prefix?: string; counter?: string } = {},
  ) => {
    const { prefix, counter } = adornment;

    const message = problem.pipe(
      Option.filter((found) => found.field === field),
      Option.map((found) => found.message),
    );

    const control: React.ComponentProps<"input"> = {
      id: field,
      name: field,
      ref: (element) => {
        fields.current[field] = element;
      },
      value: form[field],
      onChange: (event) =>
        onEdit(
          field,
          prefix === undefined
            ? event.target.value
            : event.target.value.toLowerCase(),
        ),
      inputMode: field === "amount" ? "decimal" : undefined,
      autoComplete: "off",
      autoCapitalize: "none",
      spellCheck: false,
      "aria-invalid": Option.isSome(message) ? true : undefined,
      "aria-describedby": Option.isSome(message) ? `${field}-error` : undefined,
    };

    return (
      <Field>
        <FieldLabel htmlFor={field}>{label}</FieldLabel>
        {prefix === undefined && counter === undefined ? (
          <Input {...control} />
        ) : (
          <InputGroup>
            {prefix === undefined ? null : (
              <InputGroupAddon>{prefix}</InputGroupAddon>
            )}
            <InputGroupInput {...control} />
            {counter === undefined ? null : (
              <InputGroupAddon align="inline-end">
                <span className="text-label tabular-nums">{counter}</span>
              </InputGroupAddon>
            )}
          </InputGroup>
        )}
        <FieldDescription>{hint}</FieldDescription>
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

  return (
    <form className="flex flex-1 flex-col" noValidate onSubmit={submit}>
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">
          {destination === "username"
            ? "¿A qué @usuario le envías?"
            : "¿A qué dirección le envías?"}
        </h1>
        {destination === "username"
          ? fieldInput("recipient", "Usuario", "Alguien que tenga Orchid", {
              prefix: "@",
            })
          : fieldInput(
              "recipient",
              "Dirección Stellar",
              "Empieza con G y tiene 56 caracteres",
            )}
        {fieldInput(
          "amount",
          "Monto",
          `Disponible: ${amountLabel(available, asset)}`,
        )}
        {destination === "address"
          ? fieldInput(
              "memo",
              "Memo",
              "Solo si el destino lo pide, como un exchange",
              { counter: `${memoBytes(form.memo)}/${memoByteLimit}` },
            )
          : null}
        {memoRefused ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => onEdit("memo", "")}
          >
            Quitar memo
          </Button>
        ) : null}
      </main>
      <ScreenActions>
        <Button className="w-full" type="submit">
          Revisar
        </Button>
        <Button
          className="w-full"
          type="button"
          variant="secondary"
          onClick={onChangeDestination}
        >
          Cambiar destino
        </Button>
      </ScreenActions>
    </form>
  );
}

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
  const review = useWalletRun(walletEffects.review);
  const confirmation = useWalletRun(walletEffects.confirm);
  const [editing, setEditing] = useState(Option.isNone(transfer));
  const [form, setForm] = useState<SendForm>(emptyForm);

  const [destination, setDestination] = useState<Option.Option<Destination>>(
    Option.none(),
  );

  const [intent, setIntent] = useState<Option.Option<TransferIntent>>(
    Option.none(),
  );

  const [problem, setProblem] = useState<Option.Option<FieldProblem>>(
    Option.none(),
  );

  const startOver = () => {
    review.reset();
    confirmation.reset();
    onTransfer(Option.none());
    setEditing(true);
  };

  useEffect(() => {
    const found = Option.orElse(fieldProblemOf(confirmation.state, asset), () =>
      fieldProblemOf(review.state, asset),
    );

    if (Option.isNone(found)) return;

    setProblem(found);
    startOver();
  }, [review.state, confirmation.state]);

  const reviewIntent = (entered: TransferIntent) => {
    onTransfer(Option.none());
    setIntent(Option.some(entered));
    setProblem(Option.none());
    setEditing(false);
    confirmation.reset();
    review.start(entered);
  };

  const again = () =>
    Option.match(intent, {
      onNone: startOver,
      onSome: reviewIntent,
    });

  if (editing && Option.isNone(destination))
    return (
      <DestinationChoice
        onChoose={(chosen) => {
          setForm(emptyForm);
          setProblem(Option.none());
          setDestination(Option.some(chosen));
        }}
      />
    );

  if (editing && Option.isSome(destination))
    return (
      <SendFormStep
        destination={destination.value}
        onChangeDestination={() => setDestination(Option.none())}
        form={form}
        problem={problem}
        asset={asset}
        available={available}
        onEdit={(field, value) => {
          setForm((current) => ({ ...current, [field]: value }));
          setProblem(Option.none());
        }}
        onIntent={reviewIntent}
        onProblem={(found) => setProblem(Option.some(found))}
      />
    );

  if (confirmation.state.working || Option.isSome(confirmation.state.answered))
    return (
      <AnswerScreen
        answer={confirmation.state}
        asset={asset}
        working="Enviando…"
        onConfirm={startOver}
        onEdit={startOver}
        onAgain={again}
      />
    );

  if (Option.isSome(transfer))
    return (
      <TransferStatus
        id={transfer.value}
        asset={asset}
        onStartOver={startOver}
      />
    );

  return (
    <AnswerScreen
      answer={review.state}
      asset={asset}
      working="Preparando tu pago…"
      onConfirm={(shown) => {
        onTransfer(Option.some(shown.order.id));
        confirmation.start(shown);
      }}
      onEdit={() => {
        review.reset();
        setEditing(true);
      }}
      onAgain={again}
    />
  );
}
