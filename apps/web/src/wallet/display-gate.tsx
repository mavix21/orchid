import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import type { EntryAttempt, UnlockOutcome } from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";

import {
  Screen,
  ScreenActions,
  ScreenNote,
  ScreenStatus,
} from "@/components/screen";
import { displayLock, useDisplayState } from "./display-lock";
import { unavailableMessage } from "./unavailable";
import { markWalletOnDevice } from "./wallet-cookie";

type Refusal = Exclude<UnlockOutcome, { _tag: "Unlocked" | "NoWallet" }>;

const refusal = (outcome: Refusal) =>
  Match.valueTags(outcome, {
    PasskeyCancelled: () => "No usaste tu passkey. Inténtalo de nuevo.",
    PasskeyFailed: () => "No pudimos usar tu passkey. Inténtalo de nuevo.",
    WrongCredential: () =>
      "Usaste una passkey distinta. Vuelve a intentarlo con la passkey de tu cuenta.",
    AssertionRejected: () =>
      "No pudimos verificar tu passkey. Confirma con tu huella, rostro o PIN del dispositivo e inténtalo de nuevo.",
    UnsupportedDevice: () =>
      "Este navegador no puede leer tu llave de forma segura.",
    CorruptDeviceWallet: () =>
      "Los datos guardados en este navegador están dañados.",
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    SessionRequired: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

export function DisplayGate({ children }: { children: React.ReactNode }) {
  const state = useDisplayState();

  return Predicate.isTagged(state, "Unlocked") ? children : <LockedWallet />;
}

function LockedWallet() {
  const navigate = useNavigate();
  const { walletClient } = useRouteContext({ from: "__root__" });
  const [ready, setReady] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => setReady(true), []);

  const attempt = useRef<EntryAttempt>(undefined);

  useEffect(
    () => () => {
      if (attempt.current !== undefined)
        displayLock.cancelEntry(attempt.current);
    },
    [],
  );

  const unlock = async () => {
    const entry = displayLock.attemptEntry();

    attempt.current = entry;
    setUnlocking(true);
    setProblem(undefined);

    const outcome = await walletClient.unlock();

    const refuse = (conclude: () => void) => {
      if (!displayLock.entryPending(entry)) return;

      displayLock.cancelEntry(entry);
      conclude();
    };

    Match.value(outcome).pipe(
      Match.tag("Unlocked", () => displayLock.entryVerified(entry)),
      Match.tag("NoWallet", () =>
        refuse(() => {
          markWalletOnDevice(false);
          void navigate({ to: "/", replace: true });
        }),
      ),
      Match.orElse((refused) => refuse(() => setProblem(refusal(refused)))),
    );

    setUnlocking(false);
  };

  return (
    <Screen>
      <ScreenStatus title="Tu cuenta está bloqueada">
        <ScreenNote>
          Desbloquéala con tu passkey. Puedes usar tu huella, tu rostro o el PIN
          de tu dispositivo.
        </ScreenNote>
        {problem ? (
          <p role="alert" className="text-body text-destructive">
            {problem}
          </p>
        ) : null}
      </ScreenStatus>
      <ScreenActions>
        <Button
          className="w-full"
          disabled={!ready || unlocking}
          onClick={unlock}
          data-testid="unlock-wallet"
        >
          {unlocking ? "Verificando…" : "Desbloquear con tu passkey"}
        </Button>
      </ScreenActions>
    </Screen>
  );
}
