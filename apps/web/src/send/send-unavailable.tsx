import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import type {
  InvalidAddress,
  NeedsReopening,
  UnsupportedDevice,
  WalletUnavailable,
} from "@workspace/wallet";
import * as Match from "effect/Match";

import { ScreenActions, ScreenNote, ScreenStatus } from "@/components/screen";
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
    SessionRequired: unavailableNotice,
    RateLimited: unavailableNotice,
    InvalidResponse: unavailableNotice,
  });

  return (
    <>
      <ScreenStatus title="No puedes enviar ahora">
        <ScreenNote>{notice.message}</ScreenNote>
      </ScreenStatus>
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
