import { LinkIcon, PhoneIcon, UserRoundIcon, WalletIcon } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
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
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { OptionRow } from "@/components/option-row";
import { ScreenActions, ScreenStatus } from "@/components/screen";
import { concealedLinkFor } from "@/links/concealed-link";
import { LinkFlow } from "@/links/link-flow";
import { walletEffects } from "@/wallet";

import { AmountStep } from "./amount-step";
import {
  type Destination,
  FieldProblem,
  type SendField,
  type SendForm,
} from "./intent";
import { SendScreen, deviceFailure, sendResult } from "./outcomes";
import { PaymentReviewCard } from "./payment-review";
import { RecipientStep } from "./recipient-step";
import { SendResultScreen } from "./send-result";
import { type Answer, DeviceFailure, useWalletTask } from "./use-wallet-task";

type Choice = Destination | "link";

type EntryField = "recipient" | "amount";

interface Entry {
  readonly destination: Destination;
  readonly form: SendForm;
  readonly problem: Option.Option<FieldProblem>;
}

interface Draft {
  readonly entry: Entry;
  readonly intent: TransferIntent;
}

type ReviewAnswer = Data.TaggedEnum<{
  Shown: { readonly review: PaymentReview };
  Corrected: { readonly outcome: string; readonly problem: FieldProblem };
  Concluded: { readonly outcome: string; readonly screen: SendScreen };
}>;

const ReviewAnswer = Data.taggedEnum<ReviewAnswer>();

type OutcomeAnswer = Exclude<
  ReviewAnswer,
  Data.TaggedEnum.Value<ReviewAnswer, "Shown">
>;

type SendStep = Data.TaggedEnum<{
  Choosing: {};
  Linking: {};
  Entering: { readonly field: EntryField; readonly entry: Entry };
  Reviewing: { readonly draft: Draft };
  Reviewed: { readonly draft: Draft; readonly review: PaymentReview };
  Confirming: { readonly draft: Draft; readonly review: PaymentReview };
  Concluded: {
    readonly draft: Draft;
    readonly outcome: string;
    readonly screen: SendScreen;
    readonly resume: Option.Option<TransferId>;
  };
  Tracking: { readonly id: TransferId; readonly draft: Option.Option<Draft> };
}>;

const SendStep = Data.taggedEnum<SendStep>();

type SendEvent = Data.TaggedEnum<{
  Chose: { readonly choice: Choice };
  Unchose: {};
  Typed: { readonly field: SendField; readonly value: string };
  Invalid: { readonly problem: FieldProblem };
  Moved: { readonly field: EntryField };
  ReviewStarted: { readonly intent: TransferIntent };
  ReviewAnswered: { readonly answer: ReviewAnswer };
  ConfirmStarted: {};
  ConfirmAnswered: { readonly answer: OutcomeAnswer };
  Resumed: {};
  StartedOver: {};
}>;

const SendEvent = Data.taggedEnum<SendEvent>();

const emptyForm: SendForm = { recipient: "", amount: "", memo: "" };

const readOutcome = (
  answer: Answer<ResumeOutcome>,
  asset: Asset,
): OutcomeAnswer => {
  if (answer instanceof DeviceFailure)
    return ReviewAnswer.Concluded({
      outcome: answer._tag,
      screen: deviceFailure,
    });

  const result = sendResult(answer, asset);

  return result instanceof FieldProblem
    ? ReviewAnswer.Corrected({ outcome: answer._tag, problem: result })
    : ReviewAnswer.Concluded({ outcome: answer._tag, screen: result });
};

const readReview = (
  answer: Answer<ReviewOutcome>,
  asset: Asset,
): ReviewAnswer =>
  Predicate.isTagged(answer, "PaymentReview")
    ? ReviewAnswer.Shown({ review: answer })
    : readOutcome(answer, asset);

const draftOf = (step: SendStep): Option.Option<Draft> =>
  Match.valueTags(step, {
    Choosing: () => Option.none(),
    Linking: () => Option.none(),
    Entering: () => Option.none(),
    Reviewing: ({ draft }) => Option.some(draft),
    Reviewed: ({ draft }) => Option.some(draft),
    Confirming: ({ draft }) => Option.some(draft),
    Concluded: ({ draft }) => Option.some(draft),
    Tracking: ({ draft }) => draft,
  });

const entryOf = (step: SendStep): Option.Option<Entry> =>
  Predicate.isTagged(step, "Entering")
    ? Option.some(step.entry)
    : Option.map(draftOf(step), (draft) => draft.entry);

const corrected = (entry: Entry, problem: FieldProblem) =>
  SendStep.Entering({
    field: problem.field === "recipient" ? "recipient" : "amount",
    entry: { ...entry, problem: Option.some(problem) },
  });

const editing = (
  step: SendStep,
  change: (entering: Data.TaggedEnum.Value<SendStep, "Entering">) => SendStep,
) => (Predicate.isTagged(step, "Entering") ? change(step) : step);

const reduceSendFlow = (step: SendStep, event: SendEvent): SendStep =>
  Match.valueTags(event, {
    Chose: ({ choice }) => {
      if (!Predicate.isTagged(step, "Choosing")) return step;

      return choice === "link"
        ? SendStep.Linking()
        : SendStep.Entering({
            field: "recipient",
            entry: {
              destination: choice,
              form: emptyForm,
              problem: Option.none(),
            },
          });
    },
    Unchose: () =>
      Predicate.isTagged(step, "Linking") ||
      (Predicate.isTagged(step, "Entering") && step.field === "recipient")
        ? SendStep.Choosing()
        : step,
    Typed: ({ field, value }) =>
      editing(step, (entering) =>
        SendStep.Entering({
          field: entering.field,
          entry: {
            ...entering.entry,
            form: { ...entering.entry.form, [field]: value },
            problem: Option.none(),
          },
        }),
      ),
    Invalid: ({ problem }) =>
      editing(step, (entering) =>
        SendStep.Entering({
          field: entering.field,
          entry: { ...entering.entry, problem: Option.some(problem) },
        }),
      ),
    Moved: ({ field }) =>
      editing(step, (entering) =>
        SendStep.Entering({ field, entry: entering.entry }),
      ),
    ReviewStarted: ({ intent }) =>
      Option.match(entryOf(step), {
        onNone: () => step,
        onSome: (entry) =>
          SendStep.Reviewing({
            draft: { entry: { ...entry, problem: Option.none() }, intent },
          }),
      }),
    ReviewAnswered: ({ answer }) => {
      if (!Predicate.isTagged(step, "Reviewing")) return step;

      return Match.valueTags(answer, {
        Shown: ({ review }) => SendStep.Reviewed({ draft: step.draft, review }),
        Corrected: ({ problem }) => corrected(step.draft.entry, problem),
        Concluded: ({ outcome, screen }) =>
          SendStep.Concluded({
            draft: step.draft,
            outcome,
            screen,
            resume: Option.none(),
          }),
      });
    },
    ConfirmStarted: () =>
      Predicate.isTagged(step, "Reviewed")
        ? SendStep.Confirming({ draft: step.draft, review: step.review })
        : step,
    ConfirmAnswered: ({ answer }) => {
      if (!Predicate.isTagged(step, "Confirming")) return step;

      return Match.valueTags(answer, {
        Corrected: ({ problem }) => corrected(step.draft.entry, problem),
        Concluded: ({ outcome, screen }) =>
          SendStep.Concluded({
            draft: step.draft,
            outcome,
            screen,
            resume:
              outcome === "Pending"
                ? Option.some(step.review.order.id)
                : Option.none(),
          }),
      });
    },
    Resumed: () =>
      Predicate.isTagged(step, "Concluded") && Option.isSome(step.resume)
        ? SendStep.Tracking({
            id: step.resume.value,
            draft: Option.some(step.draft),
          })
        : step,
    StartedOver: () =>
      Option.match(draftOf(step), {
        onNone: () =>
          Predicate.isTagged(step, "Tracking") ? SendStep.Choosing() : step,
        onSome: ({ entry }) => SendStep.Entering({ field: "amount", entry }),
      }),
  });

function Working({ label }: { label: string }) {
  return <ScreenStatus title={label} />;
}

function ReviewScreen({
  review,
  onConfirm,
  onEdit,
}: {
  review: PaymentReview;
  onConfirm: () => void;
  onEdit: () => void;
}) {
  return (
    <>
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">Revisa tu pago</h1>
        <PaymentReviewCard review={review} />
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          onClick={onConfirm}
          data-testid="confirm-payment"
        >
          Enviar
        </Button>
        <Button className="w-full" variant="secondary" onClick={onEdit}>
          Editar
        </Button>
      </ScreenActions>
    </>
  );
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
  const task = useWalletTask();

  const [found, setFound] = useState<Option.Option<Answer<ResumeOutcome>>>(
    Option.none(),
  );

  const look = () => {
    setFound(Option.none());
    task.run(walletEffects.resume(id), (answer) =>
      setFound(Option.some(answer)),
    );
  };

  useEffect(look, [id]);

  if (Option.isNone(found)) return <Working label="Buscando tu pago…" />;

  const answer = readOutcome(found.value, asset);

  return Match.valueTags(answer, {
    Corrected: ({ outcome, problem }) => (
      <SendResultScreen
        outcome={outcome}
        screen={
          new SendScreen(
            "Revisa los datos de tu pago",
            problem.message,
            "retry",
          )
        }
        onAgain={onStartOver}
      />
    ),
    Concluded: ({ outcome, screen }) => (
      <SendResultScreen
        outcome={outcome}
        screen={screen}
        onAgain={outcome === "Failed" ? onStartOver : look}
      />
    ),
  });
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
  nav,
  onTransfer,
}: {
  asset: Asset;
  available: Amount;
  transfer: Option.Option<TransferId>;
  nav: (locked: boolean) => React.ReactNode;
  onTransfer: (id: Option.Option<TransferId>) => void;
}) {
  const task = useWalletTask();

  const [step, send] = useReducer(
    reduceSendFlow,
    transfer,
    Option.match({
      onNone: () =>
        Option.isSome(concealedLinkFor(asset))
          ? SendStep.Linking()
          : SendStep.Choosing(),
      onSome: (id) => SendStep.Tracking({ id, draft: Option.none() }),
    }),
  );

  const startOver = () => {
    task.stop();
    onTransfer(Option.none());
    send(SendEvent.StartedOver());
  };

  const review = (intent: TransferIntent) => {
    onTransfer(Option.none());
    send(SendEvent.ReviewStarted({ intent }));
    task.run(walletEffects.review(intent), (answer) =>
      send(SendEvent.ReviewAnswered({ answer: readReview(answer, asset) })),
    );
  };

  const confirm = (shown: PaymentReview) => {
    onTransfer(Option.some(shown.order.id));
    send(SendEvent.ConfirmStarted());
    task.run(walletEffects.confirm(shown), (answered) => {
      const answer = readOutcome(answered, asset);

      if (Predicate.isTagged(answer, "Corrected")) onTransfer(Option.none());

      send(SendEvent.ConfirmAnswered({ answer }));
    });
  };

  const edit = (field: SendField, value: string) =>
    send(SendEvent.Typed({ field, value }));

  const problem = (found: FieldProblem) =>
    send(SendEvent.Invalid({ problem: found }));

  const unlocked = (screen: React.ReactNode) => (
    <>
      {nav(false)}
      {screen}
    </>
  );

  return Match.valueTags(step, {
    Linking: () => (
      <LinkFlow
        asset={asset}
        available={available}
        nav={nav}
        onChangeDestination={() => send(SendEvent.Unchose())}
      />
    ),
    Choosing: () =>
      unlocked(
        <DestinationChoice
          onChoose={(choice) => send(SendEvent.Chose({ choice }))}
        />,
      ),
    Entering: ({ field, entry }) =>
      unlocked(
        field === "recipient" ? (
          <RecipientStep
            destination={entry.destination}
            recipient={entry.form.recipient}
            problem={entry.problem}
            onEdit={(recipient) => edit("recipient", recipient)}
            onContinue={() => send(SendEvent.Moved({ field: "amount" }))}
            onProblem={problem}
            onChangeDestination={() => send(SendEvent.Unchose())}
          />
        ) : (
          <AmountStep
            destination={entry.destination}
            form={entry.form}
            problem={entry.problem}
            asset={asset}
            available={available}
            onEdit={edit}
            onIntent={review}
            onProblem={problem}
            onChangeRecipient={() =>
              send(SendEvent.Moved({ field: "recipient" }))
            }
          />
        ),
      ),
    Reviewing: () => unlocked(<Working label="Preparando tu pago…" />),
    Reviewed: ({ review: shown }) =>
      unlocked(
        <ReviewScreen
          review={shown}
          onConfirm={() => confirm(shown)}
          onEdit={startOver}
        />,
      ),
    Confirming: () => unlocked(<Working label="Enviando…" />),
    Concluded: ({ draft, outcome, screen, resume }) =>
      unlocked(
        <SendResultScreen
          outcome={outcome}
          screen={screen}
          onAgain={() =>
            Option.isSome(resume)
              ? send(SendEvent.Resumed())
              : review(draft.intent)
          }
        />,
      ),
    Tracking: ({ id }) =>
      unlocked(
        <TransferStatus id={id} asset={asset} onStartOver={startOver} />,
      ),
  });
}
