import { LinkIcon, PhoneIcon, UserRoundIcon, WalletIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
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

import { OptionRow } from "@/components/option-row";
import { ScreenActions, ScreenStatus } from "@/components/screen";
import { LinkFlow } from "@/links/link-flow";
import { walletEffects } from "@/wallet";

import { AmountStep } from "./amount-step";
import { type Destination, FieldProblem, type SendForm } from "./intent";
import { deviceFailure, sendResult } from "./outcomes";
import { PaymentReviewCard } from "./payment-review";
import { RecipientStep } from "./recipient-step";
import { SendResultScreen } from "./send-result";
import { type WalletRun, useWalletRun } from "./use-wallet-run";

type Answer = WalletRun<ReviewOutcome | ResumeOutcome>;

type Choice = Destination | "link";

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
  return <ScreenStatus title={label} />;
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
      <SendResultScreen
        outcome="DeviceFailure"
        screen={deviceFailure}
        onAgain={onAgain}
      />
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
              <Button
                className="w-full"
                onClick={() => onConfirm(shown)}
                data-testid="confirm-payment"
              >
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
            <SendResultScreen
              outcome={outcome._tag}
              screen={result}
              onAgain={onAgain}
            />
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
  onChoose: (choice: Choice) => void;
}) {
  return (
    <>
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">¿A dónde lo envías?</h1>
        <div className="flex flex-col gap-3">
          <OptionRow
            title="A un @usuario"
            description="Alguien que tenga Orchid"
            media={<UserRoundIcon />}
            render={
              <button
                type="button"
                onClick={() => onChoose("username")}
                data-testid="choose-username"
              />
            }
          />
          <OptionRow
            title="A una dirección Stellar"
            description="Otra wallet o un exchange"
            media={<WalletIcon />}
            render={
              <button
                type="button"
                onClick={() => onChoose("address")}
                data-testid="choose-address"
              />
            }
          />
          <OptionRow
            title="Con un link de pago"
            description="Alguien sin Orchid"
            media={<LinkIcon />}
            render={
              <button
                type="button"
                onClick={() => onChoose("link")}
                data-testid="choose-link"
              />
            }
          />
          <OptionRow
            title="A un teléfono"
            description="Los envíos por teléfono llegan pronto"
            media={<PhoneIcon />}
            disabled
          />
        </div>
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          variant="secondary"
          nativeButton={false}
          render={<Link to="/links" data-testid="open-links" />}
        >
          Ver mis links de pago
        </Button>
      </ScreenActions>
    </>
  );
}

export function SendFlow({
  asset,
  available,
  transfer,
  onTransfer,
  onLock,
}: {
  asset: Asset;
  available: Amount;
  transfer: Option.Option<TransferId>;
  onTransfer: (id: Option.Option<TransferId>) => void;
  onLock: (locked: boolean) => void;
}) {
  const review = useWalletRun(walletEffects.review);
  const confirmation = useWalletRun(walletEffects.confirm);
  const [editing, setEditing] = useState(Option.isNone(transfer));
  const [form, setForm] = useState<SendForm>(emptyForm);
  const [entering, setEntering] = useState<"recipient" | "amount">("recipient");

  const [destination, setDestination] = useState<Option.Option<Destination>>(
    Option.none(),
  );

  const [linking, setLinking] = useState(false);

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
    setEntering(found.value.field === "recipient" ? "recipient" : "amount");
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
    Option.exists(settledValue(confirmation.state), (value) =>
      Predicate.isTagged(value, "Pending"),
    )
      ? confirmation.reset()
      : Option.match(intent, {
          onNone: startOver,
          onSome: reviewIntent,
        });

  if (editing && linking)
    return (
      <LinkFlow
        asset={asset}
        available={available}
        onLock={onLock}
        onChangeDestination={() => setLinking(false)}
      />
    );

  if (editing && Option.isNone(destination))
    return (
      <DestinationChoice
        onChoose={(chosen) => {
          if (chosen === "link") {
            setLinking(true);

            return;
          }

          setForm(emptyForm);
          setProblem(Option.none());
          setEntering("recipient");
          setDestination(Option.some(chosen));
        }}
      />
    );

  const edit = (field: keyof SendForm, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setProblem(Option.none());
  };

  if (editing && Option.isSome(destination) && entering === "recipient")
    return (
      <RecipientStep
        destination={destination.value}
        recipient={form.recipient}
        problem={problem}
        onEdit={(recipient) => edit("recipient", recipient)}
        onContinue={() => setEntering("amount")}
        onProblem={(found) => setProblem(Option.some(found))}
        onChangeDestination={() => setDestination(Option.none())}
      />
    );

  if (editing && Option.isSome(destination))
    return (
      <AmountStep
        destination={destination.value}
        form={form}
        problem={problem}
        asset={asset}
        available={available}
        onEdit={edit}
        onIntent={reviewIntent}
        onProblem={(found) => setProblem(Option.some(found))}
        onChangeRecipient={() => setEntering("recipient")}
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
