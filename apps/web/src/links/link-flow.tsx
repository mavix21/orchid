import { CheckIcon, LinkIcon, ShareIcon } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  type Amount,
  type Asset,
  type CreatePaymentLinkOutcome,
  type PaymentLinkCreated,
  PaymentLinkIntent,
  type ResolvePaymentLinkOutcome,
  formatAmount,
  parseAmount,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { ScreenActions, ScreenNote, ScreenStatus } from "@/components/screen";
import { AmountPad } from "@/send/amount-pad";
import { amountLabel, assetCode } from "@/send/money";
import { ReviewRow } from "@/send/payment-review";
import { type Answer, useWalletTask } from "@/send/use-wallet-task";
import { walletEffects } from "@/wallet";
import { displayLock } from "@/wallet/display-lock";

import {
  LinkResultScreen,
  LinkWorking,
  ResultButton,
  ResultLink,
} from "./link-result";
import {
  type RecoverableLink,
  createLinkResult,
  lostLinkMessage,
  resolveLinkResult,
} from "./outcomes";
import {
  concealedLinkFor,
  forgetConcealed,
  keepConcealed,
} from "./concealed-link";
import {
  type Delivery,
  LinkStep,
  delivered,
  entering,
  lost,
} from "./link-step";
import { RecoverDrawer, RecoveryAnswer, useRecovery } from "./recovery";
import { type ShareResult, shareLink } from "./share-link";

interface LinkFlowState {
  readonly amount: string;
  readonly step: LinkStep;
}

type LinkEvent = Data.TaggedEnum<{
  Typed: { readonly amount: string };
  Invalid: { readonly problem: string };
  Reviewed: { readonly intent: PaymentLinkIntent };
  Edited: {};
  CreateStarted: {};
  CreateAnswered: { readonly answer: Answer<CreatePaymentLinkOutcome> };
  Retried: {};
  ShareStarted: {};
  ShareEnded: { readonly result: ShareResult };
  Left: {};
  CheckStarted: {};
  CheckAnswered: { readonly answer: Answer<ResolvePaymentLinkOutcome> };
}>;

const LinkEvent = Data.taggedEnum<LinkEvent>();

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

const reduceLinkFlow = (
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
    Reviewed: ({ intent }) =>
      Predicate.isTagged(step, "Entering")
        ? to(LinkStep.Reviewing({ intent }))
        : state,
    Edited: () =>
      Predicate.isTagged(step, "Reviewing") ||
      Predicate.isTagged(step, "Refused")
        ? to(entering())
        : state,
    CreateStarted: () =>
      Predicate.isTagged(step, "Reviewing")
        ? to(LinkStep.Creating({ intent: step.intent }))
        : state,
    CreateAnswered: ({ answer }) => {
      if (!Predicate.isTagged(step, "Creating")) return state;

      return to(
        Predicate.isTagged(answer, "PaymentLinkCreated")
          ? LinkStep.Created({ link: answer, delivery: "none" })
          : LinkStep.Refused({ intent: step.intent, outcome: answer }),
      );
    },
    Retried: () =>
      Predicate.isTagged(step, "Refused")
        ? to(LinkStep.Reviewing({ intent: step.intent }))
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

const holdsUnsharedLink = (step: LinkStep) =>
  Match.valueTags(step, {
    Entering: () => false,
    Reviewing: () => false,
    Creating: () => true,
    Refused: () => false,
    Created: ({ delivery }) => !delivered(delivery),
    Sharing: ({ delivery }) => !delivered(delivery),
    Sent: () => false,
    Lost: () => false,
    Checking: () => false,
    Checked: () => false,
  });

function LinkAmountStep({
  amount,
  problem,
  asset,
  available,
  onAmount,
  onProblem,
  onIntent,
  onChangeDestination,
}: {
  amount: string;
  problem: Option.Option<string>;
  asset: Asset;
  available: Amount;
  onAmount: (amount: string) => void;
  onProblem: (problem: string) => void;
  onIntent: (intent: PaymentLinkIntent) => void;
  onChangeDestination: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);

  const refuse = (found: string) => {
    onProblem(found);
    field.current?.focus();
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    Option.match(parseAmount(amount), {
      onNone: () => refuse("Escribe un monto válido"),
      onSome: (entered) =>
        entered > available
          ? refuse(`Tienes ${amountLabel(available, asset)} disponibles`)
          : onIntent(new PaymentLinkIntent({ asset, amount: entered })),
    });
  };

  return (
    <form className="flex flex-1 flex-col" noValidate onSubmit={submit}>
      <main className="flex flex-1 flex-col gap-4 px-5 pt-2">
        <button
          type="button"
          onClick={onChangeDestination}
          aria-label="Cambiar destino"
          data-testid="change-destination"
          className="flex items-center gap-3 rounded-lg bg-secondary px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="text-body text-muted-foreground">Para</span>
          <span className="truncate text-label-lg">Un link de pago</span>
        </button>
        <AmountPad
          amount={amount}
          problem={problem}
          asset={asset}
          available={available}
          field={field}
          onAmount={onAmount}
        />
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          type="submit"
          data-testid="review-link"
          disabled={Option.isNone(parseAmount(amount))}
        >
          Revisar
        </Button>
      </ScreenActions>
    </form>
  );
}

function LinkReview({
  intent,
  onCreate,
  onEdit,
}: {
  intent: PaymentLinkIntent;
  onCreate: () => void;
  onEdit: () => void;
}) {
  return (
    <>
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">Revisa tu link</h1>
        <dl
          aria-label="Resumen del link"
          className="flex flex-col divide-y divide-border rounded-lg border border-border px-4"
        >
          <ReviewRow label="Monto">{formatAmount(intent.amount)}</ReviewRow>
          <ReviewRow label="Moneda">{assetCode(intent.asset)}</ReviewRow>
          <ReviewRow label="Quién lo recibe">Quien abra el link</ReviewRow>
          <ReviewRow label="Comisión">Gratis</ReviewRow>
        </dl>
        <p className="text-body text-muted-foreground">
          Cualquiera que tenga el link puede recibir el dinero. Compártelo solo
          con quien quieres pagarle. Mientras nadie lo use, puedes recuperarlo.
        </p>
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          onClick={onCreate}
          data-testid="confirm-link"
        >
          Crear link
        </Button>
        <Button className="w-full" variant="secondary" onClick={onEdit}>
          Editar
        </Button>
      </ScreenActions>
    </>
  );
}

const deliveryNote = (delivery: Delivery) =>
  Match.value(delivery).pipe(
    Match.when("none", () => Option.none<string>()),
    Match.when("shared", () => Option.some("Link compartido.")),
    Match.when("copied", () =>
      Option.some("Link copiado. Pégalo en el chat de quien recibe."),
    ),
    Match.when("dismissed", () =>
      Option.some("Aún no lo compartiste. Puedes intentarlo de nuevo."),
    ),
    Match.exhaustive,
  );

function LinkReceipt({
  created,
  delivery,
}: {
  created: RecoverableLink;
  delivery: Delivery;
}) {
  const note = deliveryNote(delivery);

  return (
    <ScreenStatus
      title="Tu link está listo"
      data-testid="link-created"
      media={
        <span className="flex size-14 items-center justify-center rounded-full bg-accent text-icon-accent [&_svg]:size-7">
          <LinkIcon absoluteStrokeWidth />
        </span>
      }
    >
      <p className="font-display text-h1 text-muted-foreground">
        {amountLabel(created.amount, created.asset)}
      </p>
      <ScreenNote>
        Compártelo con quien quieres pagarle. Quien abra el link podrá recibir
        el dinero.
      </ScreenNote>
      <p className="flex min-h-6 items-center justify-center gap-2 text-label text-accent-foreground">
        {delivered(delivery) ? <CheckIcon className="size-5 shrink-0" /> : null}
        {Option.getOrUndefined(note)}
      </p>
    </ScreenStatus>
  );
}

function LinkCreated({
  created,
  delivery,
  sharing,
  onShare,
  onLeave,
}: {
  created: PaymentLinkCreated;
  delivery: Delivery;
  sharing: boolean;
  onShare: () => void;
  onLeave: () => void;
}) {
  return (
    <>
      <LinkReceipt created={created} delivery={delivery} />
      <ScreenActions>
        <Button
          className="w-full"
          onClick={onShare}
          disabled={sharing}
          data-testid="share-link"
        >
          <ShareIcon />
          {delivered(delivery) ? "Compartir de nuevo" : "Compartir link"}
        </Button>
        {delivered(delivery) ? (
          <Button
            className="w-full"
            variant="secondary"
            nativeButton={false}
            render={<Link to="/home" data-testid="finish-link" />}
          >
            Listo
          </Button>
        ) : (
          <Button
            className="w-full"
            variant="secondary"
            onClick={onLeave}
            disabled={sharing}
            data-testid="leave-link"
          >
            Salir sin compartir
          </Button>
        )}
      </ScreenActions>
    </>
  );
}

function LinkSent({
  link,
  delivery,
}: {
  link: RecoverableLink;
  delivery: Delivery;
}) {
  return (
    <>
      <LinkReceipt created={link} delivery={delivery} />
      <ScreenActions>
        <Button
          className="w-full"
          nativeButton={false}
          render={<Link to="/home" data-testid="finish-link" />}
        >
          Listo
        </Button>
      </ScreenActions>
    </>
  );
}

function LostLink({ link }: { link: RecoverableLink }) {
  const { started, recover } = useRecovery();
  const [confirming, setConfirming] = useState(false);

  if (Option.isSome(started))
    return (
      <RecoveryAnswer
        recovery={started.value}
        onRecover={recover}
        done={<ResultLink link={<Link to="/home" />}>Listo</ResultLink>}
      />
    );

  return (
    <>
      <ScreenStatus
        title="Ya no puedes compartir este link"
        data-testid="link-lost"
      >
        <ScreenNote>{lostLinkMessage}</ScreenNote>
      </ScreenStatus>
      <ScreenActions>
        <Button
          className="w-full"
          onClick={() => setConfirming(true)}
          data-testid="recover-link"
        >
          Recuperar {amountLabel(link.amount, link.asset)}
        </Button>
        <Button
          className="w-full"
          variant="secondary"
          nativeButton={false}
          render={<Link to="/links" />}
        >
          Recuperarlo después
        </Button>
      </ScreenActions>
      <RecoverDrawer
        link={link}
        open={confirming}
        onOpenChange={setConfirming}
        onRecover={recover}
      />
    </>
  );
}

export function LinkFlow({
  asset,
  available,
  nav,
  onChangeDestination,
}: {
  asset: Asset;
  available: Amount;
  nav: (locked: boolean) => React.ReactNode;
  onChangeDestination: () => void;
}) {
  const task = useWalletTask();

  const [state, send] = useReducer(reduceLinkFlow, undefined, () => ({
    amount: "",
    step: Option.getOrElse(concealedLinkFor(asset), entering),
  }));

  useEffect(() => {
    forgetConcealed();
  }, []);

  const stepRef = useRef(state.step);

  stepRef.current = state.step;

  useEffect(
    () => () => {
      if (!Predicate.isTagged(displayLock.state(), "Unlocked"))
        keepConcealed(stepRef.current);
    },
    [],
  );

  const locked = holdsUnsharedLink(state.step);

  useBlocker({ shouldBlockFn: () => locked, enableBeforeUnload: locked });

  const create = (intent: PaymentLinkIntent) => {
    send(LinkEvent.CreateStarted());
    task.run(walletEffects.createPaymentLink(intent), (answer) =>
      send(LinkEvent.CreateAnswered({ answer })),
    );
  };

  const check = () => {
    send(LinkEvent.CheckStarted());
    task.run(walletEffects.resolvePaymentLink(), (answer) =>
      send(LinkEvent.CheckAnswered({ answer })),
    );
  };

  const share = (link: PaymentLinkCreated) => {
    send(LinkEvent.ShareStarted());
    void shareLink(link).then((result) =>
      send(LinkEvent.ShareEnded({ result })),
    );
  };

  const created = (link: PaymentLinkCreated, delivery: Delivery) => (
    <LinkCreated
      created={link}
      delivery={delivery}
      sharing={Predicate.isTagged(state.step, "Sharing")}
      onShare={() => share(link)}
      onLeave={() => send(LinkEvent.Left())}
    />
  );

  return (
    <>
      {nav(locked)}
      {Match.valueTags(state.step, {
        Entering: ({ problem }) => (
          <LinkAmountStep
            amount={state.amount}
            problem={problem}
            asset={asset}
            available={available}
            onAmount={(amount) => send(LinkEvent.Typed({ amount }))}
            onProblem={(problem) => send(LinkEvent.Invalid({ problem }))}
            onIntent={(intent) => send(LinkEvent.Reviewed({ intent }))}
            onChangeDestination={onChangeDestination}
          />
        ),
        Reviewing: ({ intent }) => (
          <LinkReview
            intent={intent}
            onCreate={() => create(intent)}
            onEdit={() => send(LinkEvent.Edited())}
          />
        ),
        Creating: () => (
          <LinkWorking
            label="Creando tu link…"
            note="No cierres esta pantalla."
          />
        ),
        Refused: ({ outcome }) => {
          const screen = createLinkResult(outcome, asset);

          return (
            <LinkResultScreen outcome={outcome._tag} screen={screen}>
              {Match.value(screen.action).pipe(
                Match.when("again", () => (
                  <ResultButton onClick={() => send(LinkEvent.Retried())}>
                    Reintentar
                  </ResultButton>
                )),
                Match.when("edit", () => (
                  <ResultButton onClick={() => send(LinkEvent.Edited())}>
                    Cambiar monto
                  </ResultButton>
                )),
                Match.when("check", () => (
                  <ResultButton onClick={check}>Revisar de nuevo</ResultButton>
                )),
                Match.when("home", () => (
                  <ResultLink link={<Link to="/home" />}>
                    Volver al inicio
                  </ResultLink>
                )),
                Match.when("links", () => (
                  <ResultLink link={<Link to="/links" />}>
                    Ver mis links
                  </ResultLink>
                )),
                Match.when("assets", () => (
                  <ResultLink link={<Link to="/send" />}>
                    Elegir otra moneda
                  </ResultLink>
                )),
                Match.when("elsewhere", () => (
                  <>
                    <ResultButton onClick={onChangeDestination}>
                      Enviar de otra forma
                    </ResultButton>
                    <ResultLink variant="secondary" link={<Link to="/send" />}>
                      Elegir otra moneda
                    </ResultLink>
                  </>
                )),
                Match.exhaustive,
              )}
            </LinkResultScreen>
          );
        },
        Created: ({ link, delivery }) => created(link, delivery),
        Sharing: ({ link, delivery }) => created(link, delivery),
        Sent: ({ link, delivery }) => (
          <LinkSent link={link} delivery={delivery} />
        ),
        Lost: ({ link }) => <LostLink link={link} />,
        Checking: () => <LinkWorking label="Revisando tu link…" />,
        Checked: ({ outcome }) => {
          const screen = resolveLinkResult(outcome);

          return (
            <LinkResultScreen outcome={outcome._tag} screen={screen}>
              {Match.value(screen.action).pipe(
                Match.when("check", () => (
                  <ResultButton onClick={check}>Revisar de nuevo</ResultButton>
                )),
                Match.when("home", () => (
                  <ResultLink link={<Link to="/home" />}>
                    Volver al inicio
                  </ResultLink>
                )),
                Match.when("links", () => (
                  <ResultLink link={<Link to="/links" />}>
                    Ver mis links
                  </ResultLink>
                )),
                Match.exhaustive,
              )}
            </LinkResultScreen>
          );
        },
      })}
    </>
  );
}
