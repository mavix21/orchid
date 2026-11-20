import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import type {
  InvalidAddress,
  NeedsReopening,
  UnsupportedDevice,
  WalletUnavailable,
} from "@workspace/wallet";
import * as Match from "effect/Match";

import { ScreenActions } from "@/components/screen";
import { UnavailableNotice, unavailableNotice } from "@/wallet/unavailable";

export type UnavailableOverview =
  | NeedsReopening
  | InvalidAddress
  | UnsupportedDevice
  | WalletUnavailable;

export function SendUnavailable({
  overview,
}: {
  overview: UnavailableOverview;
}) {
  const router = useRouter();

  const notice = Match.valueTags(overview, {
    NeedsReopening: ({ profile }) =>
      new UnavailableNotice(
        `@${profile.username} necesita reabrirse antes de enviar.`,
        false,
      ),
    InvalidAddress: () =>
      new UnavailableNotice(
        "La llave guardada en este dispositivo no es válida.",
        false,
      ),
    UnsupportedDevice: () =>
      new UnavailableNotice(
        "Este navegador no puede leer tu llave de forma segura.",
        false,
      ),
    Offline: unavailableNotice,
    ServerUnreachable: unavailableNotice,
    LedgerUnreachable: unavailableNotice,
    ServiceFailed: unavailableNotice,
    InvalidResponse: unavailableNotice,
  });

  return (
    <>
      <main
        role="status"
        className="flex flex-1 flex-col justify-end gap-2 px-5"
      >
        <h1 className="font-display text-h1">No puedes enviar ahora</h1>
        <p className="text-body text-muted-foreground">{notice.message}</p>
      </main>
      <ScreenActions>
        {notice.actionable ? (
          <Button className="w-full" onClick={() => void router.invalidate()}>
            Reintentar
          </Button>
        ) : null}
        <Button
          className="w-full"
          variant={notice.actionable ? "secondary" : "default"}
          nativeButton={false}
          render={<Link to="/home" />}
        >
          Volver al inicio
        </Button>
      </ScreenActions>
    </>
  );
}
