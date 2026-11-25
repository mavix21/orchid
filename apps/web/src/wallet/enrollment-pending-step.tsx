import { Button } from "@workspace/ui/components/button";
import type { ReadLinkCode } from "@workspace/wallet";
import * as Option from "effect/Option";

import { ScreenActions, ScreenNote, ScreenStatus } from "@/components/screen";
import { UserAvatar } from "@/components/user-avatar";
import { me } from "@/fixtures/account";
import { amountLabel } from "@/send/money";
import { type Activating, receiveFor } from "@/wallet/enrollment-machine";

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
    <div className="flex flex-col items-center gap-5">
      {Option.match(step, {
        onNone: () => null,
        onSome: (label) => <StepLabel>{label}</StepLabel>,
      })}
      <div className="flex flex-col items-center gap-2">
        <UserAvatar profile={me} size="xl" />
        <p className="text-label-lg">@{username}</p>
      </div>
    </div>
  );
}

export function PendingStep({
  current,
  receive,
  onConfirm,
  onChooseAnother,
  onRecheckReceive,
  discarding,
}: {
  current: Activating;
  receive: ReadLinkCode | undefined;
  onConfirm: () => void;
  onChooseAnother: () => void;
  onRecheckReceive: () => void;
  discarding: boolean;
}) {
  const { pending, problem, receiveBlocked, refreshing } = current;
  const shownReceive = receiveFor(pending, receive);
  const releasing = pending.stage === "release";

  const waitingForReceive =
    receive !== undefined && !releasing && Option.isNone(shownReceive);

  const checkingReceive = waitingForReceive && !receiveBlocked;

  const copy = releasing
    ? {
        title: "Termina de crear tu cuenta",
        note: "No necesitas tu passkey otra vez.",
        action: "Reintentar",
      }
    : Option.match(shownReceive, {
        onNone: () => ({
          title: "Confirma tu passkey",
          note: "Usa la passkey que acabas de crear para abrir tu cuenta.",
          action:
            waitingForReceive && receiveBlocked
              ? "Crear mi cuenta sin recibir"
              : "Confirmar con passkey",
        }),
        onSome: (shown) => ({
          title: "Confirma tu passkey",
          note: `Usa la passkey que acabas de crear para abrir tu cuenta y recibir ${amountLabel(shown.amount, shown.asset)}.`,
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
            disabled={refreshing || discarding}
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
            discarding ||
            checkingReceive ||
            Option.exists(problem, (shown) => shown.stopped)
          }
          onClick={onConfirm}
        >
          {refreshing
            ? "Actualizando…"
            : checkingReceive
              ? "Revisando el link…"
              : copy.action}
        </Button>
        {releasing ? null : (
          <Button
            className="w-full"
            type="button"
            variant="ghost"
            disabled={refreshing || discarding}
            onClick={onChooseAnother}
          >
            Elegir otro @usuario
          </Button>
        )}
      </ScreenActions>
    </>
  );
}
