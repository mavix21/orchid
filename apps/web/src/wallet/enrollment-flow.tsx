import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { Field, FieldError, FieldLabel } from "@workspace/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import {
  currentUntil,
  type EnrollWalletOutcome,
  type EnrollmentPending,
  type EnrollmentStage,
  type LinkReceiveReview,
  type ReadLinkCode,
  receiveCurrentUntil,
  type ReviewEnrollmentReceiveOutcome,
  type UsernameIssue,
  usernameIssue,
  usernameMaxLength,
  usernameMinLength,
  type WalletClient,
  type WalletEnrolled,
} from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import {
  Screen,
  ScreenActions,
  ScreenNote,
  ScreenStatus,
} from "@/components/screen";
import { TopNav, type TopNavAction } from "@/components/top-nav";
import { UserAvatar } from "@/components/user-avatar";
import { me } from "@/fixtures/account";
import { receiveRefusal } from "@/links/receive-outcomes";
import { amountLabel } from "@/send/money";
import { displayLock } from "@/wallet/display-lock";
import { enrollmentClient } from "@/wallet/enrollment";
import { HumanCheckWidget } from "@/wallet/human-check-widget";
import { OpeningFlow } from "@/wallet/opening-flow";
import { retryable, unavailableMessage } from "@/wallet/unavailable";

const refusal = (
  outcome: Exclude<
    EnrollWalletOutcome,
    {
      _tag:
        | "EnrollmentPending"
        | "WalletEnrolled"
        | "WalletOnDevice"
        | "OpeningPending";
    }
  >,
) =>
  Match.valueTags(outcome, {
    InvalidUsername: () =>
      `Solo letras, números y guion bajo, de ${usernameMinLength} a ${usernameMaxLength} caracteres.`,
    UsernameTaken: ({ username }) =>
      `@${username} ya no está disponible. Elige otro usuario.`,
    DraftRejected: () =>
      "La solicitud cambió antes de firmarse. Toca de nuevo para activar tu cuenta.",
    NoWallet: () =>
      "Tu registro se interrumpió antes de guardarse. Vuelve a elegir tu @usuario.",
    BackupUnsupported: () =>
      "Este dispositivo o navegador no es compatible con passkeys con PRF. Orchid necesita una passkey compatible para crear y proteger tu cuenta.",
    PasskeyCancelled: () =>
      "Cancelaste el uso de tu passkey. Inténtalo de nuevo para continuar.",
    PasskeyFailed: () => "No pudimos usar tu passkey. Inténtalo de nuevo.",
    WrongCredential: () =>
      "Usaste una passkey distinta. Vuelve a intentarlo con la misma passkey.",
    AssertionRejected: () =>
      "No pudimos verificar tu passkey. Confirma con tu huella, rostro o PIN del dispositivo e inténtalo de nuevo.",
    CorruptEnvelope: () =>
      "No pudimos comprobar el cifrado local de tu llave. Vuelve a intentarlo.",
    CorruptDeviceWallet: () =>
      "Los datos guardados en este navegador están dañados.",
    ChallengeRefused: () => "La solicitud venció. Inténtalo de nuevo.",
    RegistrationRefused: () =>
      "No pudimos guardar el respaldo de tu cuenta. Inténtalo de nuevo.",
    UnsupportedDevice: () =>
      "Este navegador no puede guardar tu llave de forma segura.",
    LinkSecretMismatch: () =>
      "Este link está incompleto. Ábrelo de nuevo desde el mensaje que te enviaron.",
    HumanCheckRefused: () =>
      "No pudimos verificar que eres una persona. Inténtalo de nuevo.",
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

const issueMessage = (issue: UsernameIssue) =>
  Match.valueTags(issue, {
    ForbiddenCharacter: ({ character }) =>
      /\s/u.test(character)
        ? "No puede tener espacios."
        : /\p{L}/u.test(character)
          ? "Usa letras sin tildes ni ñ."
          : "Solo letras, números y guion bajo.",
    UsernameTooLong: () => `Máximo ${usernameMaxLength} caracteres.`,
    UsernameTooShort: () => `Mínimo ${usernameMinLength} caracteres.`,
  });

const stageCopy = (
  stage: EnrollmentStage,
  username: string,
  preparing: boolean,
  receive: Option.Option<LinkReceiveReview>,
) =>
  Match.value(stage).pipe(
    Match.when("activate", () =>
      preparing
        ? {
            title: "Prepara tu activación",
            description: `Aún no tenemos la solicitud de @${username}. Reintenta sin crear otra passkey.`,
            action: "Preparar de nuevo",
            busyAction: "Preparando…",
          }
        : Option.match(receive, {
            onNone: () => ({
              title: "Activa tu cuenta",
              description: `Usa tu passkey una vez para abrir @${username}, guardar su respaldo y autorizar su cierre por inactividad.`,
              action: "Activar con passkey",
              busyAction: "Activando…",
            }),
            onSome: (shown) => ({
              title: "Activa tu cuenta y recibe tu dinero",
              description: `Usa tu passkey una vez para abrir @${username}, guardar su respaldo, autorizar su cierre por inactividad y recibir ${amountLabel(shown.amount, shown.asset)} de @${shown.sender.username}.`,
              action: "Activar y recibir",
              busyAction: "Activando…",
            }),
          }),
    ),
    Match.when("release", () => ({
      title: "Termina de abrir tu cuenta",
      description: `Tu passkey ya firmó la apertura de @${username}. Reintenta sin usarla otra vez.`,
      action: "Reintentar apertura",
      busyAction: "Abriendo…",
    })),
    Match.exhaustive,
  );

function AccountMedia({ username }: { username: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <UserAvatar profile={me} size="xl" />
      <p className="text-label-lg">@{username}</p>
    </div>
  );
}

interface EnrollmentFlowProps {
  title: string;
  back: (disabled: boolean) => TopNavAction;
  walletClient: WalletClient;
  receive?: ReadLinkCode;
  onEnrolled: (enrolled: WalletEnrolled) => void;
  onOpened: () => void;
}

export function EnrollmentFlow(props: EnrollmentFlowProps) {
  return (
    <Screen>
      <EnrollmentStages {...props} />
      <HumanCheckWidget />
    </Screen>
  );
}

function EnrollmentStages({
  title,
  back,
  walletClient,
  receive,
  onEnrolled,
  onOpened,
}: EnrollmentFlowProps) {
  const [hydrated, setHydrated] = useState(false);
  const [deviceChecked, setDeviceChecked] = useState(false);
  const [username, setUsername] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [unsupportedPrf, setUnsupportedPrf] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [receiveBlocked, setReceiveBlocked] = useState(false);

  const [pending, setPending] = useState<Option.Option<EnrollmentPending>>(
    Option.none(),
  );

  const [finishing, setFinishing] = useState<Option.Option<string>>(
    Option.none(),
  );

  const [stale, setStale] = useState(false);

  const typedIssue = usernameIssue(username);
  const length = Array.from(username).length;

  const blockingIssue = typedIssue.pipe(
    Option.filter((found) => !Predicate.isTagged(found, "UsernameTooShort")),
  );

  const issue = touched ? typedIssue : blockingIssue;

  const message = Option.match(issue, {
    onNone: () => problem,
    onSome: issueMessage,
  });

  useEffect(() => {
    let current = true;

    setHydrated(true);

    void Promise.all([walletClient.saved(), enrollmentClient.pending()]).then(
      ([saved, currentPending]) => {
        if (!current) return;

        setDeviceChecked(true);

        if (Option.isSome(currentPending)) {
          setUsername(currentPending.value.username);
          setPending(currentPending);

          return;
        }

        if (Predicate.isTagged(saved, "SavedWallet")) {
          setUsername(saved.username);
          setFinishing(Option.some(saved.username));

          return;
        }

        if (Predicate.isTagged(saved, "UnsupportedDevice"))
          setProblem(
            "Este navegador no puede guardar tu llave de forma segura.",
          );
      },
    );

    return () => {
      current = false;
    };
  }, [walletClient]);

  const finishOpening = async () => {
    const saved = await walletClient.saved();

    setPending(Option.none());
    setUnsupportedPrf(false);

    if (Predicate.isTagged(saved, "SavedWallet")) {
      setUsername(saved.username);
      setFinishing(Option.some(saved.username));
      setProblem(undefined);
    } else {
      setProblem("Ya existe una cuenta guardada en este dispositivo.");
    }
  };

  const readReceive = (answer: ReviewEnrollmentReceiveOutcome) => {
    if (Predicate.isTagged(answer, "EnrollmentPending")) {
      setPending(Option.some(answer));
      setReceiveBlocked(false);

      return;
    }

    setReceiveBlocked(true);
    setProblem(receiveRefusal(answer));
  };

  const requestReceive = async () => {
    if (receive === undefined) return;

    readReceive(await enrollmentClient.reviewReceive(receive.code));
  };

  const receiveFor = (current: EnrollmentPending) =>
    Option.filter(
      Option.fromNullishOr(current.receive),
      (shown) => receive !== undefined && shown.link === receive.link,
    );

  const awaitingReceive = Option.exists(
    pending,
    (current) =>
      receive !== undefined &&
      current.stage === "activate" &&
      current.review !== undefined &&
      Option.isNone(receiveFor(current)),
  );

  useEffect(() => {
    if (!awaitingReceive || receiveBlocked || receive === undefined) return;

    let current = true;

    void enrollmentClient.reviewReceive(receive.code).then((answer) => {
      if (current) readReceive(answer);
    });

    return () => {
      current = false;
    };
  }, [awaitingReceive, receiveBlocked, receive]);

  useEffect(() => {
    if (Option.isNone(pending)) return;

    const { stage, review } = pending.value;
    const shownReceive = receiveFor(pending.value);

    if (stage !== "activate" || review === undefined) return;

    const deadline = Math.min(
      currentUntil(review),
      Option.match(shownReceive, {
        onNone: () => Number.POSITIVE_INFINITY,
        onSome: receiveCurrentUntil,
      }),
    );

    const timer = setTimeout(
      () => {
        setStale(true);
        void enrollmentClient.pending().then(async (next) => {
          setPending(next);

          if (Option.isSome(shownReceive)) await requestReceive();

          setStale(false);
        });
      },
      Math.max(0, deadline - Date.now()),
    );

    return () => clearTimeout(timer);
  }, [pending, receive]);

  const handleOutcome = async (outcome: EnrollWalletOutcome) => {
    await Match.value(outcome).pipe(
      Match.tag("EnrollmentPending", (next) => {
        setUsername(next.username);
        setPending(Option.some(next));
        setProblem(undefined);
        setUnsupportedPrf(false);
        setStopped(false);
      }),
      Match.tag("WalletEnrolled", (enrolled) => {
        setPending(Option.none());
        setProblem(undefined);
        setUnsupportedPrf(false);
        setStopped(false);
        onEnrolled(enrolled);
      }),
      Match.tag("OpeningPending", finishOpening),
      Match.tag("WalletOnDevice", finishOpening),
      Match.orElse(async (refused) => {
        const nextPending = await enrollmentClient.pending();

        setPending(nextPending);
        setProblem(refusal(refused));
        setUnsupportedPrf(Predicate.isTagged(refused, "BackupUnsupported"));
        setStopped(!retryable(refused));
      }),
    );

    setBusy(false);
  };

  const startEnrollment = async (name: string) => {
    setBusy(true);
    setProblem(undefined);
    setUnsupportedPrf(false);
    await handleOutcome(await enrollmentClient.start(name));
  };

  const continueEnrollment = async () => {
    setBusy(true);
    setProblem(undefined);
    setUnsupportedPrf(false);

    const shown = Option.isSome(pending) ? pending.value.review : undefined;

    const shownReceive = Option.isSome(pending)
      ? Option.getOrUndefined(receiveFor(pending.value))
      : undefined;

    const verifying =
      Option.isSome(pending) && pending.value.stage === "activate";

    const ticket = displayLock.begin();

    const outcome = await enrollmentClient.advance(
      shown,
      receive !== undefined && shownReceive !== undefined
        ? { review: shownReceive, code: receive.code }
        : undefined,
    );

    if (
      verifying &&
      (Predicate.isTagged(outcome, "WalletEnrolled") ||
        Predicate.isTagged(outcome, "OpeningPending"))
    )
      displayLock.unlock(ticket);

    await handleOutcome(outcome);

    if (
      shown !== undefined &&
      Predicate.isTagged(outcome, "EnrollmentPending") &&
      outcome.stage === "activate"
    )
      setProblem("La solicitud venció. Toca de nuevo para activar tu cuenta.");
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);

    if (Option.isNone(typedIssue)) void startEnrollment(username);
  };

  const nav = (disabled: boolean) => (
    <TopNav
      title={title}
      label="Atrás"
      icon={<ChevronLeftIcon />}
      disabled={disabled}
      {...back(disabled)}
    />
  );

  if (!deviceChecked) return <>{nav(false)}</>;

  if (Option.isSome(finishing))
    return (
      <>
        {nav(false)}
        <div className="flex flex-1 flex-col pb-30">
          <OpeningFlow username={finishing.value} onOpened={onOpened} />
        </div>
      </>
    );

  if (Option.isSome(pending)) {
    const shownReceive = receiveFor(pending.value);

    const copy = stageCopy(
      pending.value.stage,
      pending.value.username,
      pending.value.review === undefined,
      shownReceive,
    );

    const waitingForReceive =
      receive !== undefined &&
      pending.value.stage === "activate" &&
      Option.isNone(shownReceive);

    return (
      <>
        {nav(busy)}
        <ScreenStatus
          title={copy.title}
          media={<AccountMedia username={pending.value.username} />}
          data-testid="enrollment-step"
          data-stage={pending.value.stage}
          data-receive={Option.isSome(shownReceive)}
        >
          <ScreenNote>{copy.description}</ScreenNote>
          {problem ? (
            <p role="alert" className="text-body text-destructive">
              {problem}
            </p>
          ) : null}
        </ScreenStatus>
        <ScreenActions>
          {waitingForReceive && receiveBlocked ? (
            <Button
              className="w-full"
              type="button"
              variant="secondary"
              onClick={() => {
                setProblem(undefined);
                setReceiveBlocked(false);
              }}
            >
              Revisar el link de nuevo
            </Button>
          ) : null}
          <Button
            className="w-full"
            type="button"
            data-testid="enrollment-continue"
            disabled={
              !hydrated ||
              busy ||
              stopped ||
              stale ||
              (waitingForReceive && !receiveBlocked)
            }
            onClick={() => {
              void continueEnrollment();
            }}
          >
            {busy ? copy.busyAction : copy.action}
          </Button>
        </ScreenActions>
      </>
    );
  }

  return (
    <>
      {nav(busy)}
      <form className="flex flex-1 flex-col" noValidate onSubmit={submit}>
        <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-h1">Elige tu @usuario</h1>
            <p className="text-body text-muted-foreground">
              Así te encuentran para enviarte plata.
            </p>
          </div>
          <div className="flex justify-center">
            <UserAvatar profile={me} size="xl" />
          </div>
          <Field>
            <FieldLabel htmlFor="username">Usuario</FieldLabel>
            <InputGroup>
              <InputGroupAddon>@</InputGroupAddon>
              <InputGroupInput
                id="username"
                name="username"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value.toLowerCase());
                  setProblem(undefined);
                  setUnsupportedPrf(false);
                }}
                onBlur={() => setTouched(username.length > 0)}
                disabled={!hydrated || busy}
                aria-invalid={message ? true : undefined}
                aria-describedby={message ? "username-error" : undefined}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
              />
              <InputGroupAddon align="inline-end">
                <span
                  data-exceeded={length > usernameMaxLength}
                  className="text-label tabular-nums data-[exceeded=true]:text-destructive"
                >
                  {length}/{usernameMaxLength}
                </span>
              </InputGroupAddon>
            </InputGroup>
            {message ? (
              <FieldError
                id="username-error"
                data-testid={unsupportedPrf ? "prf-unsupported" : undefined}
              >
                {message}
              </FieldError>
            ) : null}
          </Field>
        </main>
        <ScreenActions>
          <Button
            className="w-full"
            type="submit"
            data-testid="create-submit"
            disabled={
              busy ||
              stopped ||
              username.length === 0 ||
              Option.isSome(blockingIssue)
            }
          >
            {busy ? "Creando passkey…" : "Continuar"}
          </Button>
        </ScreenActions>
      </form>
    </>
  );
}
