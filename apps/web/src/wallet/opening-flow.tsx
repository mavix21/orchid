import { useEffect, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import type {
  ConfirmOpeningOutcome,
  OpeningReview,
  WalletUnavailable,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { OrchidPending } from "@/components/orchid-pending";
import { ScreenActions, ScreenNote, ScreenStatus } from "@/components/screen";
import { walletEffects } from "@/wallet";
import { retryable, unavailableMessage } from "@/wallet/unavailable";
import {
  type Answer,
  DeviceFailure,
  useWalletTask,
} from "@/send/use-wallet-task";

type OpeningStep = Data.TaggedEnum<{
  Preparing: {};
  Shown: {
    readonly review: OpeningReview;
    readonly problem: Option.Option<string>;
  };
  Confirming: {};
  Concluded: {
    readonly title: string;
    readonly message: string;
    readonly retry: Option.Option<string>;
  };
}>;

const OpeningStep = Data.taggedEnum<OpeningStep>();

const concluded = (title: string, message: string, retry?: string) =>
  OpeningStep.Concluded({ title, message, retry: Option.fromNullishOr(retry) });

const unopened = "Tu cuenta sigue como estaba.";

const reasonToRetry = (problem: string, review: OpeningReview) =>
  OpeningStep.Shown({ review, problem: Option.some(problem) });

const readAnswer = (
  answer: Answer<ConfirmOpeningOutcome>,
  previous: Option.Option<OpeningReview>,
  onOpened: () => void,
): OpeningStep =>
  answer instanceof DeviceFailure
    ? concluded(
        "No pudimos continuar",
        `Algo falló en este dispositivo. ${unopened}`,
        "Reintentar",
      )
    : readOutcome(answer, previous, onOpened);

const readOutcome = (
  answer: ConfirmOpeningOutcome,
  previous: Option.Option<OpeningReview>,
  onOpened: () => void,
): OpeningStep => {
  const refused = (problem: string) =>
    Option.match(previous, {
      onNone: () => concluded("No pudimos continuar", problem, "Reintentar"),
      onSome: (review) => reasonToRetry(problem, review),
    });

  const unavailable = (failure: WalletUnavailable) =>
    concluded(
      "No pudimos continuar",
      unavailableMessage(failure),
      retryable(failure) ? "Reintentar" : undefined,
    );

  const unsupported = concluded(
    "No pudimos continuar",
    `Este dispositivo no pudo preparar la apertura. ${unopened}`,
  );

  return Match.valueTags(answer, {
    OpeningReview: (review) =>
      OpeningStep.Shown({
        review,
        problem:
          Option.isSome(previous) && review.redrafted
            ? Option.some("La solicitud cambió. Revísala y confirma otra vez.")
            : Option.none(),
      }),
    Opened: () => {
      onOpened();

      return OpeningStep.Preparing();
    },
    OpeningPending: () =>
      concluded(
        "Seguimos abriendo tu cuenta",
        "La red Stellar todavía está confirmando. Actualiza en unos segundos.",
        "Actualizar",
      ),
    PasskeyCancelled: () =>
      refused("No usaste tu passkey, así que no abrimos tu cuenta."),
    PasskeyFailed: () =>
      refused("No pudimos usar tu passkey. Inténtalo de nuevo."),
    HumanCheckRefused: () =>
      concluded(
        "No pudimos continuar",
        "No pudimos verificar que eres una persona. Inténtalo de nuevo.",
        "Reintentar",
      ),
    WrongCredential: () =>
      refused(
        "Usaste una passkey distinta. Confirma con la passkey de tu cuenta.",
      ),
    AssertionRejected: () =>
      refused(
        "No pudimos verificar tu passkey. Confirma con tu huella, rostro o PIN del dispositivo.",
      ),
    PrfOutputMissing: () =>
      concluded(
        "Tu passkey no puede firmar aquí",
        `Tu passkey no abrió tu llave en este dispositivo. ${unopened}`,
      ),
    CorruptDeviceWallet: () =>
      concluded(
        "No pudimos leer tu llave",
        `Los datos guardados en este navegador están dañados. ${unopened}`,
      ),
    DraftRejected: () =>
      concluded(
        "La solicitud cambió",
        `Preparamos una nueva para que la revises. ${unopened}`,
        "Reintentar",
      ),
    UsernameTaken: ({ username }) =>
      concluded(
        `@${username} ya no está disponible`,
        "Otra cuenta tomó ese usuario antes de que abrieras la tuya.",
      ),
    AddressBound: ({ profile }) =>
      concluded(
        `Esta cuenta es de @${profile.username}`,
        "Tu usuario ya está asociado a esta cuenta.",
        "Reintentar",
      ),
    NotSponsored: () =>
      concluded(
        "No podemos abrir esta cuenta",
        "Orchid no patrocina esta cuenta.",
      ),
    InvalidAddress: () =>
      concluded(
        "La llave guardada no es válida",
        "La llave guardada en este dispositivo no es una cuenta válida.",
      ),
    NoWallet: () =>
      concluded(
        "No encontramos tu cuenta",
        "Este navegador no tiene una cuenta guardada.",
      ),
    UnsupportedDevice: () =>
      concluded(
        "No pudimos leer tu llave",
        "Este navegador no puede leer tu llave de forma segura.",
      ),
    InvalidUsername: () =>
      concluded(
        "Tu usuario no es válido",
        "Solo letras, números y guion bajo.",
      ),
    BackupUnsupported: () => unsupported,
    ChallengeRefused: () => unsupported,
    RegistrationRefused: () => unsupported,
    Offline: unavailable,
    ServerUnreachable: unavailable,
    LedgerUnreachable: unavailable,
    ServiceFailed: unavailable,
    SessionRequired: unavailable,
    RateLimited: unavailable,
    InvalidResponse: unavailable,
  });
};

const closing =
  "Si tu cuenta sigue vacía y sin uso, Orchid puede cerrarla después de un día para recuperar su reserva. Tu usuario sigue siendo tuyo.";

function OpeningReviewScreen({
  review,
  arrival,
  problem,
  onConfirm,
}: {
  review: OpeningReview;
  arrival: Option.Option<string>;
  problem: Option.Option<string>;
  onConfirm: () => void;
}) {
  const reopening = Predicate.isTagged(review.draft, "OpeningDraft");

  return (
    <>
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">
          {Option.getOrElse(arrival, () =>
            reopening
              ? "Reabre tu cuenta"
              : "Autoriza el cierre por inactividad",
          )}
        </h1>
        <p className="text-label-lg" data-testid="opening-username">
          @{review.username}
        </p>
        <p className="text-body text-muted-foreground">
          {Option.isSome(arrival)
            ? "Abrimos tu cuenta y recibimos tu pago con tu passkey."
            : closing}
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
          onClick={onConfirm}
          data-testid="confirm-opening"
        >
          {Option.isSome(arrival)
            ? "Recibir con passkey"
            : reopening
              ? "Reabrir con passkey"
              : "Autorizar con passkey"}
        </Button>
      </ScreenActions>
    </>
  );
}

export function OpeningFlow({
  username,
  arrival = Option.none(),
  onOpened,
}: {
  username: string;
  arrival?: Option.Option<string>;
  onOpened: () => void;
}) {
  const task = useWalletTask();
  const [step, setStep] = useState<OpeningStep>(OpeningStep.Preparing());

  const confirm = (shown: OpeningReview) => {
    setStep(OpeningStep.Confirming());
    task.run(walletEffects.confirmOpening(shown), (answer) =>
      setStep(readAnswer(answer, Option.some(shown), onOpened)),
    );
  };

  const look = () => {
    setStep(OpeningStep.Preparing());
    task.run(walletEffects.reviewOpening(username), (answer) => {
      const next = readAnswer(answer, Option.none(), onOpened);

      if (
        Option.isSome(arrival) &&
        Predicate.isTagged(next, "Shown") &&
        Option.isNone(next.problem)
      )
        confirm(next.review);
      else setStep(next);
    });
  };

  useEffect(look, [username]);

  return Match.valueTags(step, {
    Preparing: () => (
      <OrchidPending
        title={Option.getOrElse(arrival, () => "Preparando tu cuenta…")}
      />
    ),
    Confirming: () => (
      <OrchidPending
        title={Option.getOrElse(arrival, () => "Abriendo tu cuenta…")}
        note={
          Option.isSome(arrival)
            ? "Abriendo tu cuenta. Esto toma unos segundos."
            : "Esto toma unos segundos."
        }
      />
    ),
    Shown: ({ review, problem }) => (
      <OpeningReviewScreen
        review={review}
        arrival={arrival}
        problem={problem}
        onConfirm={() => confirm(review)}
      />
    ),
    Concluded: ({ title, message, retry }) => (
      <>
        <ScreenStatus title={title}>
          <ScreenNote>{message}</ScreenNote>
        </ScreenStatus>
        {Option.isSome(retry) ? (
          <ScreenActions>
            <Button className="w-full" onClick={look}>
              {retry.value}
            </Button>
          </ScreenActions>
        ) : null}
      </>
    ),
  });
}
