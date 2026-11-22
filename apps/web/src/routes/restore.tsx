import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import type { RestoreOutcome } from "@workspace/wallet";
import * as Match from "effect/Match";

import { PasskeyBrowserGate } from "@/browser/passkey-browser-gate";
import { Screen, ScreenActions } from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { useHomeForSavedWallet } from "@/wallet/use-home-for-saved-wallet";
import { retryable, unavailableMessage } from "@/wallet/unavailable";

export const Route = createFileRoute("/restore")({
  component: () => (
    <PasskeyBrowserGate>
      <RestoreAccount />
    </PasskeyBrowserGate>
  ),
});

const refusal = (
  outcome: Exclude<RestoreOutcome, { _tag: "Restored" | "WalletOnDevice" }>,
) =>
  Match.valueTags(outcome, {
    BackupUnsupported: () =>
      "Este navegador no puede abrir tu respaldo con esa passkey.",
    PasskeyCancelled: () => "No usaste ninguna passkey. Inténtalo de nuevo.",
    PasskeyFailed: () => "No pudimos usar tu passkey. Inténtalo de nuevo.",
    ChallengeRefused: () => "La solicitud venció. Inténtalo de nuevo.",
    NoBackup: () => "No encontramos un respaldo para esa passkey.",
    AssertionRefused: () =>
      "No pudimos verificar esa passkey. Inténtalo de nuevo.",
    BackupMismatch: () =>
      "El respaldo no coincide con la cuenta. No lo guardamos.",
    UnsupportedDevice: () =>
      "Este navegador no puede guardar tu llave de forma segura.",
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

function RestoreAccount() {
  const navigate = useNavigate();
  const { walletClient } = Route.useRouteContext();
  const [restoring, setRestoring] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [stopped, setStopped] = useState(false);

  useHomeForSavedWallet();

  const restore = async () => {
    setRestoring(true);
    setProblem(undefined);

    const outcome = await walletClient.restore();

    await Match.value(outcome).pipe(
      Match.tag("Restored", "WalletOnDevice", () =>
        navigate({ to: "/home", replace: true }),
      ),
      Match.orElse((refused) => {
        setProblem(refusal(refused));
        setStopped(!retryable(refused));
        setRestoring(false);
      }),
    );
  };

  return (
    <Screen>
      <TopNav
        title="Restaurar cuenta"
        label="Atrás"
        icon={<ChevronLeftIcon />}
        link={<Link to="/" />}
      />
      <main className="flex flex-1 flex-col gap-2 px-5 pt-2">
        <h1 className="font-display text-h1">Entra con tu passkey</h1>
        <p className="text-body text-muted-foreground">
          Usa la passkey con la que respaldaste tu cuenta. Tu @usuario y tu
          saldo vuelven a este dispositivo.
        </p>
        {problem ? (
          <p role="alert" className="text-body text-destructive">
            {problem}
          </p>
        ) : null}
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          disabled={restoring || stopped}
          onClick={restore}
          data-testid="restore-submit"
        >
          {restoring ? "Restaurando…" : "Restaurar con passkey"}
        </Button>
      </ScreenActions>
    </Screen>
  );
}
