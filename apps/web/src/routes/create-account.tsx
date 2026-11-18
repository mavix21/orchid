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
  type CreateOutcome,
  type UsernameIssue,
  usernameIssue,
  usernameMaxLength,
  usernameMinLength,
} from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { Screen, ScreenActions } from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { UserAvatar } from "@/components/user-avatar";
import { me } from "@/fixtures/account";

export const Route = createFileRoute("/create-account")({
  component: ChooseUsername,
});

const refusal = (outcome: Exclude<CreateOutcome, { _tag: "Opened" }>) =>
  Match.valueTags(outcome, {
    InvalidUsername: () =>
      `Solo letras, números y guion bajo, de ${usernameMinLength} a ${usernameMaxLength} caracteres.`,
    UsernameTaken: () => "Ese usuario ya está tomado. Prueba con otro.",
    AddressBound: ({ profile }) => `Tu llave ya es @${profile.username}.`,
    OpeningPending: () =>
      "Tu cuenta se está abriendo. Vuelve a intentarlo en un momento.",
    DraftRejected: () =>
      "Recibimos una transacción inesperada y no la firmamos.",
    UnsupportedDevice: () =>
      "Este navegador no puede guardar tu llave de forma segura.",
    InvalidAddress: () => "No pudimos abrir tu cuenta.",
    NotSponsored: () => "No pudimos abrir tu cuenta.",
    PasskeyCancelled: () =>
      "Necesitas crear una passkey para respaldar tu cuenta. Inténtalo de nuevo.",
    ChallengeRefused: () => "El respaldo tardó demasiado. Inténtalo de nuevo.",
    RegistrationRefused: () =>
      "No pudimos guardar el respaldo de tu cuenta. Inténtalo de nuevo.",
    Offline: () => "Sin conexión. Inténtalo de nuevo.",
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

function ChooseUsername() {
  const navigate = useNavigate();
  const { walletClient } = Route.useRouteContext();
  const [username, setUsername] = useState("");
  const [touched, setTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [problem, setProblem] = useState<string>();

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

  const create = async (name: string) => {
    setCreating(true);
    setProblem(undefined);

    const outcome = await walletClient.create(name);

    await Match.value(outcome).pipe(
      Match.tag("Opened", () => navigate({ to: "/home" })),
      Match.orElse((refused) => {
        setProblem(refusal(refused));
        setCreating(false);
        setResuming(false);
      }),
    );
  };

  useEffect(() => {
    let current = true;

    void walletClient.saved().then((saved) => {
      if (!current || !Predicate.isTagged(saved, "SavedWallet")) return;

      setUsername(saved.username);

      if (!saved.openingApproved) return;

      setResuming(true);
      void create(saved.username);
    });

    return () => {
      current = false;
    };
  }, [walletClient]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);

    if (Option.isNone(typedIssue)) void create(username);
  };

  return (
    <Screen>
      <TopNav
        title="Crea tu cuenta"
        label="Atrás"
        icon={<ChevronLeftIcon />}
        link={<Link to="/" />}
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
                }}
                onBlur={() => setTouched(username.length > 0)}
                disabled={resuming}
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
              <FieldError id="username-error">{message}</FieldError>
            ) : null}
          </Field>
        </main>
        <ScreenActions>
          <Button
            className="w-full"
            type="submit"
            disabled={
              creating || username.length === 0 || Option.isSome(blockingIssue)
            }
          >
            {resuming
              ? "Terminando de crear tu cuenta…"
              : creating
                ? "Creando tu cuenta…"
                : "Continuar"}
          </Button>
        </ScreenActions>
      </form>
    </Screen>
  );
}
