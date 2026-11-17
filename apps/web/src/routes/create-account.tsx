import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@workspace/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import type { CreateOutcome } from "@workspace/wallet";
import * as Match from "effect/Match";

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
      "Usa de 3 a 20 caracteres: letras minúsculas, números o _.",
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
    Offline: () => "Sin conexión. Inténtalo de nuevo.",
  });

function ChooseUsername() {
  const navigate = useNavigate();
  const { walletClient } = Route.useRouteContext();
  const [username, setUsername] = useState("");
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string>();

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true);
    setProblem(undefined);

    const outcome = await walletClient.create(username);

    await Match.value(outcome).pipe(
      Match.tag("Opened", () => navigate({ to: "/home" })),
      Match.orElse((refused) => {
        setProblem(refusal(refused));
        setCreating(false);
      }),
    );
  };

  return (
    <Screen>
      <TopNav
        title="Crea tu cuenta"
        label="Atrás"
        icon={<ChevronLeftIcon />}
        link={<Link to="/" />}
      />
      <form className="flex flex-1 flex-col" onSubmit={create}>
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
                onChange={(event) =>
                  setUsername(event.target.value.toLowerCase())
                }
                aria-invalid={problem ? true : undefined}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
              />
            </InputGroup>
            {problem ? (
              <FieldError>{problem}</FieldError>
            ) : (
              <FieldDescription>Es permanente: elígelo bien.</FieldDescription>
            )}
          </Field>
        </main>
        <ScreenActions>
          <Button
            className="w-full"
            type="submit"
            disabled={creating || username.length === 0}
          >
            {creating ? "Creando tu cuenta…" : "Continuar"}
          </Button>
        </ScreenActions>
      </form>
    </Screen>
  );
}
