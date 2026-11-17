import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";

import { BrandLogo } from "@/components/brand-logo";
import { Screen, ScreenActions } from "@/components/screen";

export const Route = createFileRoute("/")({
  component: Welcome,
});

function Welcome() {
  return (
    <Screen>
      <main className="flex flex-1 flex-col gap-2 px-5 pt-2 pb-6">
        <BrandLogo />
        <div className="flex-1" />
        <h1 className="font-display text-display">Tu plata, sin bancos.</h1>
        <p className="text-body-lg text-muted-foreground">
          Envía y cobra dólares con un link.
        </p>
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          nativeButton={false}
          render={<Link to="/create-account" />}
        >
          Crear cuenta
        </Button>
        <Button
          className="w-full"
          variant="ghost"
          nativeButton={false}
          render={<Link to="/home" />}
        >
          Ya tengo una cuenta
        </Button>
        <p className="text-caption text-muted-foreground">
          Tu llave se queda en tu teléfono.
        </p>
      </ScreenActions>
    </Screen>
  );
}
