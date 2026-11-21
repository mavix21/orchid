import { CheckIcon, LinkIcon, ShareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { ScreenActions } from "@/components/screen";
import { AmountPad } from "@/send/amount-pad";
import { amountLabel, assetCode } from "@/send/money";
import { ReviewRow } from "@/send/payment-review";
import { type WalletRun, useWalletRun } from "@/send/use-wallet-run";
import { walletEffects } from "@/wallet";

import { LinkResultScreen, LinkWorking } from "./link-result";
import {
  type RecoverableLink,
  createLinkResult,
  creationDeviceFailure,
  lostLinkMessage,
  resolveLinkResult,
} from "./outcomes";
import { RecoverDrawer, RecoveryAnswer } from "./recovery";
import { type ShareResult, shareLink } from "./share-link";

type Delivery = ShareResult | "waiting" | "abandoned";

const delivered = (delivery: Delivery) =>
  delivery === "shared" || delivery === "copied";

const createdLink = (answer: WalletRun<CreatePaymentLinkOutcome>) =>
  answer.working
    ? Option.none<PaymentLinkCreated>()
    : answer.answered.pipe(
        Option.filter(Exit.isSuccess),
        Option.flatMap((exit) =>
          Predicate.isTagged(exit.value, "PaymentLinkCreated")
            ? Option.some(exit.value)
            : Option.none(),
        ),
      );

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

  useEffect(() => {
    if (Option.isSome(problem)) field.current?.focus();
  }, [problem]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    Option.match(parseAmount(amount), {
      onNone: () => onProblem("Escribe un monto válido"),
      onSome: (entered) =>
        entered > available
          ? onProblem(`Tienes ${amountLabel(available, asset)} disponibles`)
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
          <ReviewRow label="Activo">{assetCode(intent.asset)}</ReviewRow>
          <ReviewRow label="Quién lo recibe">Quien abra el link</ReviewRow>
          <ReviewRow label="Comisión">Orchid paga la comisión</ReviewRow>
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
    Match.when("shared", () => Option.some("Link compartido.")),
    Match.when("copied", () =>
      Option.some("Link copiado. Pégalo en el chat de quien recibe."),
    ),
    Match.when("dismissed", () =>
      Option.some("Aún no lo compartiste. Puedes intentarlo de nuevo."),
    ),
    Match.orElse(() => Option.none<string>()),
  );

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
  const note = deliveryNote(delivery);

  return (
    <>
      <main
        data-testid="link-created"
        className="flex flex-1 flex-col justify-end gap-4 px-5"
      >
        <span className="flex size-14 items-center justify-center rounded-full bg-accent text-icon-accent [&_svg]:size-7">
          <LinkIcon absoluteStrokeWidth />
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-h1">Tu link está listo</h1>
          <p className="font-display text-h1 text-muted-foreground">
            {amountLabel(created.amount, created.asset)}
          </p>
        </div>
        <p className="text-body text-muted-foreground">
          Compártelo con quien quieres pagarle. Quien abra el link podrá recibir
          el dinero.
        </p>
        <p
          role="status"
          className="flex min-h-6 items-center gap-2 text-label text-accent-foreground"
        >
          {delivered(delivery) ? <CheckIcon className="size-5" /> : null}
          {Option.getOrUndefined(note)}
        </p>
      </main>
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

function LostLink({
  link,
  onRecover,
}: {
  link: RecoverableLink;
  onRecover: (link: RecoverableLink) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <main
        role="status"
        data-testid="link-lost"
        className="flex flex-1 flex-col justify-end gap-2 px-5"
      >
        <h1 className="font-display text-h1">Tu link no se compartió</h1>
        <p className="text-body text-muted-foreground">{lostLinkMessage}</p>
      </main>
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
          Ver mis links
        </Button>
      </ScreenActions>
      <RecoverDrawer
        link={link}
        open={confirming}
        onOpenChange={setConfirming}
        onRecover={onRecover}
      />
    </>
  );
}

export function LinkFlow({
  asset,
  available,
  onLock,
  onChangeDestination,
}: {
  asset: Asset;
  available: Amount;
  onLock: (locked: boolean) => void;
  onChangeDestination: () => void;
}) {
  const creation = useWalletRun(walletEffects.createPaymentLink);

  const check = useWalletRun<void, ResolvePaymentLinkOutcome>(
    walletEffects.resolvePaymentLink,
  );

  const recovery = useWalletRun(walletEffects.cancelPaymentLink);
  const [amount, setAmount] = useState("");
  const [problem, setProblem] = useState<Option.Option<string>>(Option.none());

  const [intent, setIntent] = useState<Option.Option<PaymentLinkIntent>>(
    Option.none(),
  );

  const [delivery, setDelivery] = useState<Delivery>("waiting");
  const [sharing, setSharing] = useState(false);

  const [recovering, setRecovering] = useState<Option.Option<RecoverableLink>>(
    Option.none(),
  );

  const created = createdLink(creation.state);

  const locked =
    creation.state.working ||
    (Option.isSome(created) &&
      !delivered(delivery) &&
      delivery !== "abandoned" &&
      delivery !== "unavailable");

  useEffect(() => onLock(locked), [locked]);
  useEffect(() => () => onLock(false), []);

  useBlocker({ shouldBlockFn: () => locked, enableBeforeUnload: locked });

  const recover = (link: RecoverableLink) => {
    setRecovering(Option.some(link));
    recovery.start(link);
  };

  const startOver = () => {
    creation.reset();
    check.reset();
    recovery.reset();
    setRecovering(Option.none());
    setDelivery("waiting");
    setIntent(Option.none());
  };

  const create = (entered: PaymentLinkIntent) => {
    setDelivery("waiting");
    check.reset();
    creation.start(entered);
  };

  const share = async (link: PaymentLinkCreated) => {
    setSharing(true);

    const result = await shareLink(link);

    setDelivery((current) =>
      delivered(current) && !delivered(result) ? current : result,
    );
    setSharing(false);
  };

  if (Option.isSome(recovering))
    return (
      <RecoveryAnswer
        answer={recovery.state}
        link={recovering.value}
        onAgain={() => recovery.start(recovering.value)}
      />
    );

  if (check.state.working || Option.isSome(check.state.answered)) {
    if (check.state.working || Option.isNone(check.state.answered))
      return <LinkWorking label="Revisando tu link…" />;

    return Exit.match(check.state.answered.value, {
      onFailure: () => (
        <LinkResultScreen
          outcome="DeviceFailure"
          screen={creationDeviceFailure}
          onAgain={startOver}
          onEdit={startOver}
          onCheck={() => check.start()}
        />
      ),
      onSuccess: (outcome) =>
        Predicate.isTagged(outcome, "ResolvedPaymentLink") ? (
          <LostLink link={outcome} onRecover={recover} />
        ) : (
          <LinkResultScreen
            outcome={outcome._tag}
            screen={resolveLinkResult(outcome)}
            onAgain={startOver}
            onEdit={startOver}
            onCheck={() => check.start()}
          />
        ),
    });
  }

  if (creation.state.working)
    return (
      <LinkWorking label="Creando tu link…" note="No cierres esta pantalla." />
    );

  if (Option.isSome(creation.state.answered))
    return Exit.match(creation.state.answered.value, {
      onFailure: () => (
        <LinkResultScreen
          outcome="DeviceFailure"
          screen={creationDeviceFailure}
          onAgain={startOver}
          onEdit={startOver}
          onCheck={() => check.start()}
        />
      ),
      onSuccess: (outcome) =>
        Predicate.isTagged(outcome, "PaymentLinkCreated") ? (
          delivery === "abandoned" || delivery === "unavailable" ? (
            <LostLink link={outcome} onRecover={recover} />
          ) : (
            <LinkCreated
              created={outcome}
              delivery={delivery}
              sharing={sharing}
              onShare={() => void share(outcome)}
              onLeave={() => setDelivery("abandoned")}
            />
          )
        ) : (
          <LinkResultScreen
            outcome={outcome._tag}
            screen={createLinkResult(outcome, asset)}
            onAgain={() => creation.reset()}
            onEdit={startOver}
            onCheck={() => check.start()}
          />
        ),
    });

  if (Option.isSome(intent))
    return (
      <LinkReview
        intent={intent.value}
        onCreate={() => create(intent.value)}
        onEdit={() => setIntent(Option.none())}
      />
    );

  return (
    <LinkAmountStep
      amount={amount}
      problem={problem}
      asset={asset}
      available={available}
      onAmount={(typed) => {
        setAmount(typed);
        setProblem(Option.none());
      }}
      onProblem={(found) => setProblem(Option.some(found))}
      onIntent={(entered) => setIntent(Option.some(entered))}
      onChangeDestination={onChangeDestination}
    />
  );
}
