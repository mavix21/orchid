import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import type {
  RestoreOpened,
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
  { _tag: "Restored" | "WalletOnDevice" | "RestoreOpened" | "RestoreSealed" }
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
    UnsupportedDevice: () =>
      "Este navegador no puede guardar tu llave de forma segura.",
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

const stageCopy = (progress: RestoreOpened | RestoreSealed | undefined) =>
  Match.value(progress).pipe(
    Match.tag("RestoreOpened", ({ profile }) => ({
      description: `Abrimos el respaldo de @${profile.username}. Ahora guardamos tu cuenta en este dispositivo con otra confirmación de tu passkey.`,
      action: "Guardar en este dispositivo",
    })),
    Match.tag("RestoreSealed", () => ({
      description:
        "Guardamos tu cuenta en este dispositivo. Confirma una vez más con tu passkey para comprobar que se abre.",
      action: "Comprobar con passkey",
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
  const [progress, setProgress] = useState<RestoreOpened | RestoreSealed>();
  const copy = stageCopy(progress);

  useHomeForSavedWallet();

  const restore = async () => {
    setRestoring(true);
    setProblem(undefined);

    const outcome = await walletClient.restore();

    await Match.value(outcome).pipe(
      Match.tag("Restored", "WalletOnDevice", () =>
        navigate({ to: "/home", replace: true }),
      ),
      Match.tag("RestoreOpened", "RestoreSealed", (next) => {
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
