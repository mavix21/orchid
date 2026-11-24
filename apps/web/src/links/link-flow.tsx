import { LinkIcon, ShareIcon } from "lucide-react";
import { useEffect, useEffectEvent, useReducer, useRef } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldTitle,
} from "@workspace/ui/components/field";
import { Switch } from "@workspace/ui/components/switch";
import {
  type Amount,
  type Asset,
  type PaymentLinkCreated,
  PaymentLinkIntent,
  type PaymentReview,
  type PositiveAmount,
  type SavedLinkTarget,
  formatAmount,
  parseAmount,
} from "@workspace/wallet";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { ReviewHero } from "@/components/review-hero";
import { ScreenActions, ScreenNote, ScreenStatus } from "@/components/screen";
import { AmountPad } from "@/send/amount-pad";
import { amountLabel } from "@/send/money";
import { ReviewRow } from "@/send/payment-review";
import { useWalletTask } from "@/send/use-wallet-task";
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
  preparedLinkResult,
  resolveLinkResult,
} from "./outcomes";
import {
  concealedLinkFor,
  forgetConcealed,
  keepConcealed,
} from "./concealed-link";
import { type Delivery, LinkStep, delivered, entering } from "./link-step";
import { RecoveryAnswer, useRecovery } from "./recovery";
import {
  LinkEvent,
  holdsUnsharedLink,
  reduceLinkFlow,
} from "./link-flow-state";
import {
  DeliveryActions,
  DeliveryNote,
  LinkShareDrawer,
  useLinkReveal,
} from "./link-reveal";
import { type ShareResult, copyLink, shareLink } from "./share-link";

const withSaving = (intent: PaymentLinkIntent, saveOnDevice: boolean) =>
  new PaymentLinkIntent({ ...intent, saveOnDevice });

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
          : onIntent(
              new PaymentLinkIntent({
                asset,
                amount: entered,
                saveOnDevice: true,
              }),
            ),
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

const renewalLeadMillis = 30_000;
const renewalFloorMillis = 5_000;

function LinkReview({
  intent,
  review,
  problem,
  renewing,
  onSave,
  onRenew,
  onCreate,
}: {
  intent: PaymentLinkIntent;
  review: PaymentReview;
  problem: Option.Option<string>;
  renewing: boolean;
  onSave: (saveOnDevice: boolean) => void;
  onRenew: () => void;
  onCreate: () => void;
}) {
  const renew = useEffectEvent(onRenew);

  useEffect(() => {
    if (renewing) return;

    const untilExpiry =
      DateTime.toEpochMillis(review.expiresAt) -
      DateTime.toEpochMillis(DateTime.nowUnsafe());

    const timer = setTimeout(
      renew,
      Math.max(untilExpiry - renewalLeadMillis, renewalFloorMillis),
    );

    return () => clearTimeout(timer);
  }, [review, renewing]);

  return (
    <>
      <main
        className="flex flex-1 flex-col gap-6 px-5 pt-2"
        data-testid="link-review"
        data-saved={intent.saveOnDevice}
      >
        <ReviewHero
          title="Revisa tu link"
          amount={amountLabel(review.amount, review.asset)}
          network={review.network}
        />
        <dl className="flex flex-col rounded-lg border border-border px-4">
          <ReviewRow label="Comisión">Gratis</ReviewRow>
        </dl>
        <p className="text-body text-muted-foreground">
          Quien tenga el link recibe el dinero. Puedes recuperarlo mientras
          nadie lo use.
        </p>
        <FieldLabel htmlFor="save-link">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Guardar para compartir de nuevo</FieldTitle>
            </FieldContent>
            <Switch
              id="save-link"
              checked={intent.saveOnDevice}
              readOnly={renewing}
              onCheckedChange={onSave}
              data-testid="save-link"
            />
          </Field>
        </FieldLabel>
        {Option.isSome(problem) ? (
          <p role="alert" className="text-body text-destructive">
            {problem.value}
          </p>
        ) : null}
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          onClick={onCreate}
          disabled={renewing}
          data-testid="confirm-link"
        >
          Crear link
        </Button>
      </ScreenActions>
    </>
  );
}

function LinkReceipt({
  created,
  delivery,
}: {
  created: RecoverableLink;
  delivery: Delivery;
}) {
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
      <ScreenNote>Compártelo con quien quieres pagarle.</ScreenNote>
      <DeliveryNote delivery={delivery} />
    </ScreenStatus>
  );
}

function LinkCreated({
  created,
  delivery,
  sharing,
  onShare,
  onCopy,
  onLeave,
}: {
  created: PaymentLinkCreated;
  delivery: Delivery;
  sharing: boolean;
  onShare: () => void;
  onCopy: () => void;
  onLeave: () => void;
}) {
  return (
    <>
      <LinkReceipt created={created} delivery={delivery} />
      <ScreenActions>
        <DeliveryActions
          delivering={sharing}
          onShare={onShare}
          onCopy={onCopy}
        />
        {created.savedOnDevice || delivered(delivery) ? (
          <Button
            className="w-full"
            variant="ghost"
            nativeButton={false}
            render={<Link to="/home" data-testid="finish-link" />}
          >
            {delivered(delivery) ? "Listo" : "Compartir después"}
          </Button>
        ) : (
          <Button
            className="w-full"
            variant="ghost"
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
  const { started, begin, confirm, reset } = useRecovery();

  if (Option.isSome(started))
    return (
      <RecoveryAnswer
        recovery={started.value}
        onBegin={begin}
        onConfirm={confirm}
        onCancel={reset}
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
          onClick={() => begin(link)}
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
    </>
  );
}

function SavedLink({ link }: { link: SavedLinkTarget }) {
  const { started, begin, confirm, reset } = useRecovery();
  const sharing = useLinkReveal();

  if (Option.isSome(started))
    return (
      <RecoveryAnswer
        recovery={started.value}
        onBegin={begin}
        onConfirm={confirm}
        onCancel={reset}
        done={<ResultLink link={<Link to="/home" />}>Listo</ResultLink>}
      />
    );

  return (
    <>
      <ScreenStatus
        title="Tu link está guardado"
        data-testid="link-saved"
        media={
          <span className="flex size-14 items-center justify-center rounded-full bg-accent text-icon-accent [&_svg]:size-7">
            <LinkIcon absoluteStrokeWidth />
          </span>
        }
      >
        <p className="font-display text-h1 text-muted-foreground">
          {amountLabel(link.amount, link.asset)}
        </p>
        <ScreenNote>
          Compártelo de nuevo o recupera el dinero mientras nadie lo use.
        </ScreenNote>
      </ScreenStatus>
      <ScreenActions>
        <Button
          className="w-full"
          onClick={() => sharing.open(link)}
          data-testid="reshare-link"
        >
          <ShareIcon />
          Compartir link
        </Button>
        <Button
          className="w-full"
          variant="secondary"
          onClick={() => begin(link)}
          data-testid="recover-link"
        >
          Recuperar {amountLabel(link.amount, link.asset)}
        </Button>
      </ScreenActions>
      <LinkShareDrawer
        sharing={sharing}
        onRecover={(target) => begin(target)}
      />
    </>
  );
}

const startingStep = (
  asset: Asset,
  initialAmount: Option.Option<PositiveAmount>,
): LinkStep =>
  Option.getOrElse(concealedLinkFor(asset), () =>
    Option.match(initialAmount, {
      onNone: entering,
      onSome: (amount) =>
        LinkStep.Reviewing({
          intent: new PaymentLinkIntent({ asset, amount, saveOnDevice: true }),
        }),
    }),
  );

export function LinkFlow({
  asset,
  available,
  initialAmount,
  nav,
  onChangeDestination,
}: {
  asset: Asset;
  available: Amount;
  initialAmount: Option.Option<PositiveAmount>;
  nav: (locked: boolean, edit?: () => void) => React.ReactNode;
  onChangeDestination: () => void;
}) {
  const task = useWalletTask();

  const [state, send] = useReducer(reduceLinkFlow, undefined, () => ({
    amount: Option.match(initialAmount, {
      onNone: () => "",
      onSome: formatAmount,
    }),
    step: startingStep(asset, initialAmount),
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

  const review = (intent: PaymentLinkIntent) =>
    task.run(walletEffects.reviewPaymentLink(intent), (answer) =>
      send(LinkEvent.ReviewAnswered({ answer })),
    );

  const prepare = (intent: PaymentLinkIntent) => {
    send(LinkEvent.ReviewStarted({ intent }));
    review(intent);
  };

  const prepareOffered = useEffectEvent(() => {
    if (
      Predicate.isTagged(state.step, "Reviewing") &&
      Option.isSome(initialAmount)
    )
      review(state.step.intent);
  });

  useEffect(prepareOffered, []);

  const create = (review: PaymentReview) => {
    send(LinkEvent.CreateStarted());
    task.run(walletEffects.confirmPaymentLink(review), (answer) =>
      send(LinkEvent.CreateAnswered({ answer })),
    );
  };

  const edit = () => send(LinkEvent.Edited());

  const check = () => {
    send(LinkEvent.CheckStarted());
    task.run(walletEffects.resolvePaymentLink(), (answer) =>
      send(LinkEvent.CheckAnswered({ answer })),
    );
  };

  const deliver = (
    link: PaymentLinkCreated,
    handOff: (shared: PaymentLinkCreated) => Promise<ShareResult>,
  ) => {
    send(LinkEvent.ShareStarted());
    void handOff(link).then((result) => send(LinkEvent.ShareEnded({ result })));
  };

  const reviewed = (
    intent: PaymentLinkIntent,
    review: PaymentReview,
    problem: Option.Option<string>,
    renewing: boolean,
  ) => (
    <LinkReview
      intent={intent}
      review={review}
      problem={problem}
      renewing={renewing}
      onSave={(saveOnDevice) => prepare(withSaving(intent, saveOnDevice))}
      onRenew={() => prepare(intent)}
      onCreate={() => create(review)}
    />
  );

  const created = (link: PaymentLinkCreated, delivery: Delivery) => (
    <LinkCreated
      created={link}
      delivery={delivery}
      sharing={Predicate.isTagged(state.step, "Sharing")}
      onShare={() => deliver(link, shareLink)}
      onCopy={() => deliver(link, copyLink)}
      onLeave={() => send(LinkEvent.Left())}
    />
  );

  return (
    <>
      {nav(
        locked,
        Predicate.isTagged(state.step, "Reviewed") ||
          Predicate.isTagged(state.step, "Renewing")
          ? edit
          : undefined,
      )}
      {Match.valueTags(state.step, {
        Entering: ({ problem }) => (
          <LinkAmountStep
            amount={state.amount}
            problem={problem}
            asset={asset}
            available={available}
            onAmount={(amount) => send(LinkEvent.Typed({ amount }))}
            onProblem={(problem) => send(LinkEvent.Invalid({ problem }))}
            onIntent={prepare}
            onChangeDestination={onChangeDestination}
          />
        ),
        Reviewing: () => <LinkWorking label="Preparando tu link…" />,
        Reviewed: ({ intent, review, problem }) =>
          reviewed(intent, review, problem, false),
        Renewing: ({ intent, review }) =>
          reviewed(intent, review, Option.none(), true),
        Creating: () => (
          <LinkWorking
            label="Creando tu link…"
            note="No cierres esta pantalla."
          />
        ),
        Refused: ({ intent, confirmed, outcome }) => {
          const screen = (confirmed ? createLinkResult : preparedLinkResult)(
            outcome,
            asset,
          );

          return (
            <LinkResultScreen outcome={outcome._tag} screen={screen}>
              {Match.value(screen.action).pipe(
                Match.when("once", () => (
                  <ResultButton
                    onClick={() => prepare(withSaving(intent, false))}
                  >
                    Crear sin guardarlo
                  </ResultButton>
                )),
                Match.when("again", () => (
                  <ResultButton onClick={() => prepare(intent)}>
                    Reintentar
                  </ResultButton>
                )),
                Match.when("edit", () => (
                  <ResultButton onClick={edit}>Cambiar monto</ResultButton>
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
        Saved: ({ link }) => <SavedLink link={link} />,
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
