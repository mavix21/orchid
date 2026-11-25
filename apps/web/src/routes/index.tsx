import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";

import { BrandLogo } from "@/components/brand-logo";
import { OrchidBloom } from "@/components/orchid-bloom";
import { Screen, ScreenActions } from "@/components/screen";
import { useHomeForSavedWallet } from "@/wallet/use-home-for-saved-wallet";
import { deviceHoldsWallet } from "@/wallet/wallet-cookie";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (deviceHoldsWallet()) throw redirect({ to: "/home" });
  },
  component: Welcome,
});

function Welcome() {
  useHomeForSavedWallet();

  return (
    <Screen>
      <main className="flex flex-1 flex-col gap-2 px-5 pt-2 pb-6 md:px-8 md:pt-8">
        <div className="md:hidden">
          <BrandLogo />
        </div>
        <div className="flex-1 md:hidden" />
        <div className="hidden flex-1 items-center justify-center py-6 md:flex">
          <div className="relative">
            <div
              aria-hidden="true"
              className="orchid-glow absolute -inset-1/4 rounded-full opacity-50"
            />
            <OrchidBloom motion="breathe" className="relative size-36" />
          </div>
        </div>
        <h1 className="font-display text-display">Tu plata, sin bancos.</h1>
        <p className="text-body-lg text-muted-foreground">
          Envía y cobra dólares con un link.
        </p>
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          nativeButton={false}
          render={<Link to="/create-account" data-testid="start-create" />}
        >
          Crear cuenta
        </Button>
        <Button
          className="w-full"
          variant="ghost"
          nativeButton={false}
          render={<Link to="/restore" data-testid="start-restore" />}
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
