import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
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
    { _tag: "EnrollmentPending" | "WalletEnrolled" | "WalletOnDevice" }
  >,
) =>
  Match.valueTags(outcome, {
    InvalidUsername: () =>
      `Solo letras, números y guion bajo, de ${usernameMinLength} a ${usernameMaxLength} caracteres.`,
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

const stageCopy = (stage: EnrollmentStage, username: string) =>
  Match.value(stage).pipe(
    Match.when("prf", () => ({
      title: "Verifica tu passkey",
      description: `Toca para comprobar que tu passkey puede proteger @${username} en este dispositivo.`,
      action: "Verificar con passkey",
      busyAction: "Verificando…",
    })),
    Match.when("backup", () => ({
      title: "Guarda tu respaldo",
      description: `No pudimos guardar el respaldo de @${username}. Reintenta sin crear otra passkey.`,
      action: "Reintentar respaldo",
      busyAction: "Guardando respaldo…",
    })),
    Match.when("reopen", () => ({
      title: "Confirma tu passkey",
      description: `Usa tu passkey una vez más para comprobar que puede abrir @${username} antes de activar tu cuenta.`,
      action: "Confirmar con passkey",
      busyAction: "Confirmando…",
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

  const [enrolledUsername, setEnrolledUsername] = useState<
    Option.Option<string>
  >(Option.none());

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

        if (Predicate.isTagged(saved, "SavedWallet")) {
          setUsername(saved.username);
          setEnrolledUsername(Option.some(saved.username));
          setPending(Option.none());

          return;
        }

        if (Predicate.isTagged(saved, "UnsupportedDevice")) {
          setProblem(
            "Este navegador no puede guardar tu llave de forma segura.",
          );

          return;
        }

        if (Option.isSome(currentPending)) {
          setUsername(currentPending.value.username);
          setPending(currentPending);
        }
      },
    );

    return () => {
      current = false;
    };
  }, [walletClient]);

  const handleOutcome = async (outcome: EnrollWalletOutcome) => {
    await Match.value(outcome).pipe(
      Match.tag("EnrollmentPending", (next) => {
        setUsername(next.username);
        setPending(Option.some(next));
        setProblem(undefined);
        setUnsupportedPrf(false);
        setStopped(false);
      }),
      Match.tag("WalletEnrolled", ({ profile }) => {
        setUsername(profile.username);
        setEnrolledUsername(Option.some(profile.username));
        setPending(Option.none());
        setProblem(undefined);
        setUnsupportedPrf(false);
        setStopped(false);
      }),
      Match.tag("WalletOnDevice", async () => {
        const saved = await walletClient.saved();

        setPending(Option.none());
        setUnsupportedPrf(false);

        if (Predicate.isTagged(saved, "SavedWallet")) {
          setUsername(saved.username);
          setEnrolledUsername(Option.some(saved.username));
          setProblem(undefined);
        } else {
          setProblem("Ya existe una cuenta guardada en este dispositivo.");
        }
      }),
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
    const ticket = displayLock.begin();
    const outcome = await enrollmentClient.advance();

    if (Predicate.isTagged(outcome, "WalletEnrolled"))
      displayLock.unlock(ticket);

    await handleOutcome(outcome);
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

  if (Option.isSome(enrolledUsername))
    return (
      <Screen>
        <TopNav
          title="Crea tu cuenta"
          label="Atrás"
          icon={<ChevronLeftIcon />}
          link={<Link to="/" />}
        />
        <ScreenStatus
          title={`Tu passkey protege @${enrolledUsername.value}`}
          media={<AccountMedia username={enrolledUsername.value} />}
          data-testid="enrollment-complete"
        >
          <ScreenNote>
            El respaldo y la comprobación local con passkey terminaron bien. La
            apertura de la cuenta permanecerá pausada hasta habilitar la
            autorización revisada.
          </ScreenNote>
        </ScreenStatus>
      </Screen>
    );

  if (Option.isSome(pending)) {
    const copy = stageCopy(pending.value.stage, pending.value.username);

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
            disabled={!hydrated || busy || stopped}
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
