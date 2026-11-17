import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";

import { BrandLogo } from "@/components/brand-logo";
import { Screen } from "@/components/screen";

export const Route = createFileRoute("/")({
  component: Bienvenida,
});

// Figma 01a · Bienvenida · Mobile (27:3).
function Bienvenida() {
  return (
    <Screen>
      <main className="flex flex-1 flex-col gap-4 px-6 pt-6">
        <BrandLogo />
        <div className="flex-1" />
        <h1 className="font-display text-display-balance">
          Tu plata, sin bancos.
        </h1>
        <p className="text-body-lg text-muted-foreground">
          Envía y cobra dólares con un link.
        </p>
      </main>
      <div className="flex flex-col items-center gap-2 px-5 pt-10 pb-8.5">
        <Button
          className="w-full"
          nativeButton={false}
          render={<Link to="/crear-cuenta" />}
        >
          Crear cuenta
        </Button>
        <Button
          className="w-full"
          variant="ghost"
          nativeButton={false}
          render={<Link to="/inicio" />}
        >
          Ya tengo una cuenta
        </Button>
        <p className="text-caption text-muted-foreground">
          Tu llave se queda en tu teléfono.
        </p>
      </div>
    </Screen>
  );
}
