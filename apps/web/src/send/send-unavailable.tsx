import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import type {
  InvalidAddress,
  NeedsReopening,
  Offline,
  UnsupportedDevice,
} from "@workspace/wallet";
import * as Match from "effect/Match";

import { ScreenActions } from "@/components/screen";

export type UnavailableOverview =
  | NeedsReopening
  | InvalidAddress
  | UnsupportedDevice
  | Offline;

export function SendUnavailable({
  overview,
}: {
  overview: UnavailableOverview;
}) {
  const message = Match.valueTags(overview, {
    NeedsReopening: ({ profile }) =>
      `@${profile.username} necesita reabrirse antes de enviar.`,
    InvalidAddress: () => "La llave guardada en este dispositivo no es válida.",
    UnsupportedDevice: () =>
      "Este navegador no puede leer tu llave de forma segura.",
    Offline: () => "Sin conexión. Inténtalo de nuevo.",
  });

  return (
    <>
      <main
        role="status"
        className="flex flex-1 flex-col justify-end gap-2 px-5"
      >
        <h1 className="font-display text-h1">No puedes enviar ahora</h1>
        <p className="text-body text-muted-foreground">{message}</p>
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          nativeButton={false}
          render={<Link to="/home" />}
        >
          Volver al inicio
        </Button>
      </ScreenActions>
    </>
  );
}
