import { LinkIcon, ShareIcon } from "lucide-react";
import { useEffect, useReducer, useRef } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  type Amount,
  type Asset,
  type PaymentLinkCreated,
  PaymentLinkIntent,
  type PaymentReview,
  type SavedLinkTarget,
  formatAmount,
  parseAmount,
} from "@workspace/wallet";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

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
import { type Delivery, delivered, entering } from "./link-step";
import { AssetLine, FullValue, RecoveryAnswer, useRecovery } from "./recovery";
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

const oneTime = (intent: PaymentLinkIntent) =>
  new PaymentLinkIntent({ ...intent, saveOnDevice: false });

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

function LinkReview({
  intent,
  review,
  problem,
  onCreate,
  onOnce,
  onEdit,
}: {
  intent: PaymentLinkIntent;
  review: PaymentReview;
  problem: Option.Option<string>;
  onCreate: () => void;
  onOnce: () => void;
  onEdit: () => void;
}) {
  return (
    <>
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">Revisa tu link</h1>
        <dl
          aria-label="Resumen del link"
          data-testid="link-review"
          data-saved={intent.saveOnDevice}
          className="flex flex-col divide-y divide-border rounded-lg border border-border px-4"
        >
          <ReviewRow label="Monto">{formatAmount(review.amount)}</ReviewRow>
          <ReviewRow label="Moneda">
            <AssetLine asset={review.asset} />
          </ReviewRow>
          <ReviewRow label="Quién lo recibe">
            <span className="flex flex-col items-end">
              <span>Quien abra el link</span>
              <FullValue>{review.to}</FullValue>
            </span>
          </ReviewRow>
          <ReviewRow label="Cuenta">
            <FullValue>{review.order.from}</FullValue>
          </ReviewRow>
          <ReviewRow label="Red">Stellar {review.network}</ReviewRow>
          <ReviewRow label="Confirma antes de">
            {DateTime.toDate(review.expiresAt).toLocaleTimeString("es-PE", {
              timeStyle: "short",
            })}
          </ReviewRow>
          <ReviewRow label="Comisión">Gratis</ReviewRow>
          <ReviewRow label="Guardar el link">
            {intent.saveOnDevice ? "En este dispositivo" : "No, solo ahora"}
          </ReviewRow>
        </dl>
        <p className="text-body text-muted-foreground">
          Cualquiera que tenga el link puede recibir el dinero. Compártelo solo
          con quien quieres pagarle. Mientras nadie lo use, puedes recuperarlo.
          Tu passkey confirma que eres tú, pero no muestra los datos del link.
          Revísalos aquí antes de crearlo.
        </p>
        <p className="text-body text-muted-foreground">
          {intent.saveOnDevice
            ? "Guardamos el link cifrado solo en este dispositivo para que puedas compartirlo otra vez con tu passkey."
            : "No guardaremos el link: compártelo apenas esté listo."}
        </p>
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
          data-testid="confirm-link"
        >
          Crear link
        </Button>
        <Button className="w-full" variant="secondary" onClick={onEdit}>
          Editar
        </Button>
        {intent.saveOnDevice ? (
          <Button
            className="w-full"
            variant="ghost"
            onClick={onOnce}
            data-testid="once-link"
          >
            Crear sin guardarlo
          </Button>
        ) : null}
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
      <ScreenNote>
        Compártelo con quien quieres pagarle. Quien abra el link podrá recibir
        el dinero.
      </ScreenNote>
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
          Puedes compartirlo de nuevo con tu passkey o recuperar el dinero
          mientras nadie lo use.
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

  const prepare = (intent: PaymentLinkIntent) => {
    send(LinkEvent.ReviewStarted({ intent }));
    task.run(walletEffects.reviewPaymentLink(intent), (answer) =>
      send(LinkEvent.ReviewAnswered({ answer })),
    );
  };

  const create = (review: PaymentReview) => {
    send(LinkEvent.CreateStarted());
    task.run(walletEffects.confirmPaymentLink(review), (answer) =>
      send(LinkEvent.CreateAnswered({ answer })),
    );
  };

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
            onIntent={prepare}
            onChangeDestination={onChangeDestination}
          />
        ),
        Reviewing: () => <LinkWorking label="Preparando tu link…" />,
        Reviewed: ({ intent, review, problem }) => (
          <LinkReview
            intent={intent}
            review={review}
            problem={problem}
            onCreate={() => create(review)}
            onOnce={() => prepare(oneTime(intent))}
            onEdit={() => send(LinkEvent.Edited())}
          />
        ),
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
                  <ResultButton onClick={() => prepare(oneTime(intent))}>
                    Crear sin guardarlo
                  </ResultButton>
                )),
                Match.when("again", () => (
                  <ResultButton onClick={() => prepare(intent)}>
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
