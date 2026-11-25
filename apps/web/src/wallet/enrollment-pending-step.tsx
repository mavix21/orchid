import { Button } from "@workspace/ui/components/button";
import type { ReadLinkCode } from "@workspace/wallet";
import * as Option from "effect/Option";

import { ScreenActions, ScreenNote, ScreenStatus } from "@/components/screen";
import { UserAvatar } from "@/components/user-avatar";
import { me } from "@/fixtures/account";
import { amountLabel } from "@/send/money";
import { type Activating, receiveFor } from "@/wallet/enrollment-machine";

const closing =
  "Si tu cuenta queda vacía y sin uso por un día, Orchid puede cerrarla para recuperar su reserva. Tu @usuario sigue siendo tuyo.";

export function StepLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-label text-primary">{children}</p>;
}

function AccountMedia({
  username,
  step,
}: {
  username: string;
  step: Option.Option<string>;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <UserAvatar profile={me} size="xl" />
      <p className="text-label-lg">@{username}</p>
      {Option.match(step, {
        onNone: () => null,
        onSome: (label) => <StepLabel>{label}</StepLabel>,
      })}
    </div>
  );
}

export function PendingStep({
  current,
  receive,
  onConfirm,
  onChooseAnother,
  onRecheckReceive,
}: {
  current: Activating;
  receive: ReadLinkCode | undefined;
  onConfirm: () => void;
  onChooseAnother: () => void;
  onRecheckReceive: () => void;
}) {
  const { pending, problem, receiveBlocked, refreshing } = current;
  const shownReceive = receiveFor(pending, receive);
  const releasing = pending.stage === "release";
  const preparing = !releasing && pending.review === undefined;

  const waitingForReceive =
    receive !== undefined && !releasing && Option.isNone(shownReceive);

  const copy = releasing
    ? {
        title: "Termina de abrir tu cuenta",
        note: `Tu passkey ya confirmó la apertura de @${pending.username}. No tendrás que usarla otra vez.`,
        action: "Reintentar",
      }
    : preparing
      ? {
          title: "Prepara tu activación",
          note: `Aún no tenemos la solicitud de @${pending.username}. Reintenta; no crearás otra passkey.`,
          action: "Preparar de nuevo",
        }
      : Option.match(shownReceive, {
          onNone: () => ({
            title: "Confirma tu passkey",
            note: `Usa la passkey que acabas de crear. Con ella ciframos tu respaldo y abrimos @${pending.username}.`,
            action:
              waitingForReceive && receiveBlocked
                ? "Abrir mi cuenta sin recibir"
                : "Confirmar con passkey",
          }),
          onSome: (shown) => ({
            title: "Confirma tu passkey",
            note: `Usa la passkey que acabas de crear. Con ella ciframos tu respaldo, abrimos @${pending.username} y recibes ${amountLabel(shown.amount, shown.asset)} de @${shown.sender.username}.`,
            action: "Confirmar y recibir",
          }),
        });

  return (
    <>
      <ScreenStatus
        title={copy.title}
        media={
          <AccountMedia
            username={pending.username}
            step={releasing ? Option.none() : Option.some("Paso 2 de 2")}
          />
        }
        data-testid="enrollment-step"
        data-stage={pending.stage}
        data-receive={Option.isSome(shownReceive)}
      >
        <ScreenNote>{copy.note}</ScreenNote>
        {releasing ? null : (
          <p className="text-label text-pretty text-muted-foreground">
            {closing}
          </p>
        )}
        {Option.match(problem, {
          onNone: () => null,
          onSome: (shown) => (
            <p
              role="alert"
              className="text-body text-destructive"
              data-testid={shown.prfUnsupported ? "prf-unsupported" : undefined}
            >
              {shown.message}
            </p>
          ),
        })}
      </ScreenStatus>
      <ScreenActions>
        {waitingForReceive && receiveBlocked ? (
          <Button
            className="w-full"
            type="button"
            variant="secondary"
            onClick={onRecheckReceive}
          >
            Revisar el link de nuevo
          </Button>
        ) : null}
        <Button
          className="w-full"
          type="button"
          data-testid="enrollment-continue"
          disabled={
            refreshing ||
            Option.exists(problem, (shown) => shown.stopped) ||
            (waitingForReceive && !receiveBlocked)
          }
          onClick={onConfirm}
        >
          {copy.action}
        </Button>
        {releasing ? null : (
          <Button
            className="w-full"
            type="button"
            variant="ghost"
            onClick={onChooseAnother}
          >
            Elegir otro @usuario
          </Button>
        )}
      </ScreenActions>
    </>
  );
}
