import { ChevronLeftIcon } from "lucide-react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group";

import { Screen, ScreenActions } from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { UserAvatar } from "@/components/user-avatar";
import { me } from "@/fixtures/account";

export const Route = createFileRoute("/crear-cuenta")({
  component: EligeTuUsuario,
});

// Figma 01b · Elige tu usuario · Mobile (27:42).
function EligeTuUsuario() {
  return (
    <Screen>
      <TopNav
        title="Crea tu cuenta"
        label="Atrás"
        icon={<ChevronLeftIcon />}
        link={<Link to="/" />}
      />
      <main className="flex flex-1 flex-col gap-6 px-5 pt-4">
        <h1 className="font-display text-h1">Elige tu @usuario</h1>
        <p className="text-body text-muted-foreground">
          Así te encuentran para enviarte plata.
        </p>
        <div className="flex justify-center pt-4 pb-2">
          <UserAvatar profile={me} size="xl" />
        </div>
        <Field>
          <FieldLabel htmlFor="usuario">Usuario</FieldLabel>
          <InputGroup>
            <InputGroupAddon>@</InputGroupAddon>
            <InputGroupInput
              id="usuario"
              name="usuario"
              defaultValue={me.username}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
            />
          </InputGroup>
          <FieldDescription>Disponible</FieldDescription>
        </Field>
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          nativeButton={false}
          render={<Link to="/inicio" />}
        >
          Continuar
        </Button>
      </ScreenActions>
    </Screen>
  );
}
