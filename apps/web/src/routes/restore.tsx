import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import type {
  BackupLocated,
  RestoreOutcome,
  RestoreSealed,
} from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";

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

type Refusal = Exclude<
  RestoreOutcome,
  { _tag: "Restored" | "BackupLocated" | "RestoreSealed" }
>;

const refusal = (outcome: Refusal) =>
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
    RestoreUnverified: () =>
      "No pudimos comprobar la copia en este dispositivo. Tu respaldo sigue intacto. Inténtalo de nuevo.",
    UnsupportedDevice: () =>
      "Este navegador no puede guardar tu llave de forma segura.",
    CorruptDeviceWallet: () =>
      "Los datos guardados en este dispositivo están dañados. No los reemplazamos.",
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

const stageCopy = (progress: BackupLocated | RestoreSealed | undefined) =>
  Match.value(progress).pipe(
    Match.tag("BackupLocated", ({ profile }) => ({
      description: `Encontramos el respaldo de @${profile.username}. Confirma con tu passkey para prepararlo en este dispositivo.`,
      action: "Preparar en este dispositivo",
    })),
    Match.tag("RestoreSealed", () => ({
      description:
        "Tu cuenta está lista para guardarse en este dispositivo. Una última confirmación con tu passkey comprueba que se abre y termina la restauración.",
      action: "Terminar con passkey",
    })),
    Match.orElse(() => ({
      description:
        "Usa la passkey con la que respaldaste tu cuenta. Tu @usuario y tu saldo vuelven a este dispositivo.",
      action: "Restaurar con passkey",
    })),
  );

function RestoreAccount() {
  const navigate = useNavigate();
  const { walletClient } = Route.useRouteContext();
  const [restoring, setRestoring] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState<BackupLocated | RestoreSealed>();
  const copy = stageCopy(progress);

  useHomeForSavedWallet();

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      void walletClient.cancelRestore();
    };
  }, [walletClient]);

  const restore = async () => {
    setRestoring(true);
    setProblem(undefined);

    const outcome = await walletClient.restore();

    if (!mounted.current) return;

    await Match.value(outcome).pipe(
      Match.tag("Restored", () => navigate({ to: "/home", replace: true })),
      Match.tag("BackupLocated", "RestoreSealed", (next) => {
        setProgress(next);
        setRestoring(false);
      }),
      Match.orElse((refused) => {
        if (!Predicate.isTagged(refused, "PasskeyCancelled"))
          setProgress(undefined);

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
        <p className="text-body text-muted-foreground">{copy.description}</p>
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
          {restoring ? "Restaurando…" : copy.action}
        </Button>
      </ScreenActions>
    </Screen>
  );
}
