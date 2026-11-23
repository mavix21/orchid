import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Field, FieldError, FieldLabel } from "@workspace/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import {
  type EnrollWalletOutcome,
  type EnrollmentPending,
  type EnrollmentStage,
  type UsernameIssue,
  usernameIssue,
  usernameMaxLength,
  usernameMinLength,
} from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { PasskeyBrowserGate } from "@/browser/passkey-browser-gate";
import {
  Screen,
  ScreenActions,
  ScreenNote,
  ScreenStatus,
} from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { UserAvatar } from "@/components/user-avatar";
import { me } from "@/fixtures/account";
import { displayLock } from "@/wallet/display-lock";
import { enrollmentClient } from "@/wallet/enrollment";
import { OpeningFlow } from "@/wallet/opening-flow";
import { retryable, unavailableMessage } from "@/wallet/unavailable";

export const Route = createFileRoute("/create-account")({
  component: () => (
    <PasskeyBrowserGate>
      <ChooseUsername />
    </PasskeyBrowserGate>
  ),
});

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
        : {
            title: "Activa tu cuenta",
            description: `Usa tu passkey una vez para abrir @${username}, guardar su respaldo y autorizar su cierre por inactividad.`,
            action: "Activar con passkey",
            busyAction: "Activando…",
          },
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

function ChooseUsername() {
  const [hydrated, setHydrated] = useState(false);
  const [deviceChecked, setDeviceChecked] = useState(false);
  const { walletClient } = Route.useRouteContext();
  const [username, setUsername] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [unsupportedPrf, setUnsupportedPrf] = useState(false);
  const [stopped, setStopped] = useState(false);

  const [pending, setPending] = useState<Option.Option<EnrollmentPending>>(
    Option.none(),
  );

  const [finishing, setFinishing] = useState<Option.Option<string>>(
    Option.none(),
  );

  const [stale, setStale] = useState(false);
  const navigate = useNavigate();

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

  const goHome = () => {
    void navigate({ to: "/home", replace: true });
  };

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

  useEffect(
    () => () => {
      void enrollmentClient.retire();
    },
    [],
  );

  useEffect(() => {
    if (Option.isNone(pending)) return;

    const { stage, currentUntil } = pending.value;

    if (stage !== "activate" || currentUntil === undefined) return;

    const timer = setTimeout(
      () => {
        setStale(true);
        void enrollmentClient.pending().then((next) => {
          setPending(next);
          setStale(false);
        });
      },
      Math.max(0, currentUntil - Date.now()),
    );

    return () => clearTimeout(timer);
  }, [pending]);

  const handleOutcome = async (outcome: EnrollWalletOutcome) => {
    await Match.value(outcome).pipe(
      Match.tag("EnrollmentPending", (next) => {
        setUsername(next.username);
        setPending(Option.some(next));
        setProblem(undefined);
        setUnsupportedPrf(false);
        setStopped(false);
      }),
      Match.tag("WalletEnrolled", () => {
        setPending(Option.none());
        setProblem(undefined);
        setUnsupportedPrf(false);
        setStopped(false);
        goHome();
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

    const verifying =
      Option.isSome(pending) && pending.value.stage === "activate";

    const ticket = displayLock.begin();

    const outcome = await enrollmentClient.advance(
      Option.isSome(pending) ? pending.value.currentUntil : undefined,
    );

    if (
      verifying &&
      (Predicate.isTagged(outcome, "WalletEnrolled") ||
        Predicate.isTagged(outcome, "OpeningPending"))
    )
      displayLock.unlock(ticket);

    await handleOutcome(outcome);

    if (
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

  if (!deviceChecked)
    return (
      <Screen>
        <TopNav
          title="Crea tu cuenta"
          label="Atrás"
          icon={<ChevronLeftIcon />}
          link={<Link to="/" />}
        />
      </Screen>
    );

  if (Option.isSome(finishing))
    return (
      <Screen>
        <TopNav
          title="Crea tu cuenta"
          label="Atrás"
          icon={<ChevronLeftIcon />}
          link={<Link to="/" />}
        />
        <div className="flex flex-1 flex-col pb-30">
          <OpeningFlow username={finishing.value} onOpened={goHome} />
        </div>
      </Screen>
    );

  if (Option.isSome(pending)) {
    const copy = stageCopy(
      pending.value.stage,
      pending.value.username,
      pending.value.currentUntil === undefined,
    );

    return (
      <Screen>
        <TopNav
          title="Crea tu cuenta"
          label="Atrás"
          icon={<ChevronLeftIcon />}
          link={<Link to="/" disabled={busy} />}
          disabled={busy}
        />
        <ScreenStatus
          title={copy.title}
          media={<AccountMedia username={pending.value.username} />}
          data-testid="enrollment-step"
          data-stage={pending.value.stage}
        >
          <ScreenNote>{copy.description}</ScreenNote>
          {problem ? (
            <p role="alert" className="text-body text-destructive">
              {problem}
            </p>
          ) : null}
        </ScreenStatus>
        <ScreenActions>
          <Button
            className="w-full"
            type="button"
            data-testid="enrollment-continue"
            disabled={!hydrated || busy || stopped || stale}
            onClick={() => {
              void continueEnrollment();
            }}
          >
            {busy ? copy.busyAction : copy.action}
          </Button>
        </ScreenActions>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopNav
        title="Crea tu cuenta"
        label="Atrás"
        icon={<ChevronLeftIcon />}
        link={<Link to="/" disabled={busy} />}
        disabled={busy}
      />
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
    </Screen>
  );
}
