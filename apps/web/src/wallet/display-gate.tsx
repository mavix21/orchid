import { useEffect, useRef, useState } from "react";
import {
  useNavigate,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import type { EntryAttempt } from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";

import {
  Screen,
  ScreenActions,
  ScreenNote,
  ScreenStatus,
} from "@/components/screen";
import { displayLock, useDisplayState } from "./display-lock";
import { useSessionChallenge } from "./session-challenge";
import { sessionLapse, useSessionLapsed } from "./session-lapse";
import { sessionRefusal } from "./session-refusal";
import { markWalletOnDevice } from "./wallet-cookie";

export function DisplayGate({ children }: { children: React.ReactNode }) {
  const state = useDisplayState();
  const lapsed = useSessionLapsed();

  return Predicate.isTagged(state, "Unlocked") && !lapsed ? (
    children
  ) : (
    <LockedWallet />
  );
}

function LockedWallet() {
  const navigate = useNavigate();
  const router = useRouter();
  const lapsed = useSessionLapsed();
  const { walletClient } = useRouteContext({ from: "__root__" });
  const { held, refresh } = useSessionChallenge(walletClient);
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

    const outcome = await walletClient.unlock(
      Predicate.isTagged(held, "Ready") ? held.challenge : undefined,
    );

    const refuse = (conclude: () => void) => {
      if (!displayLock.entryPending(entry)) return;

      displayLock.cancelEntry(entry);
      conclude();
    };

    Match.value(outcome).pipe(
      Match.tag("Unlocked", () => {
        displayLock.entryVerified(entry);
        sessionLapse.clear();

        if (lapsed) void router.invalidate();
      }),
      Match.tag("NoWallet", () =>
        refuse(() => {
          markWalletOnDevice(false);
          void navigate({ to: "/", replace: true });
        }),
      ),
      Match.orElse((refused) =>
        refuse(() => {
          setProblem(sessionRefusal(refused));
          void refresh();
        }),
      ),
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
          disabled={!ready || unlocking || Predicate.isTagged(held, "Fetching")}
          onClick={unlock}
          data-testid="unlock-wallet"
        >
          {unlocking ? "Verificando…" : "Desbloquear con tu passkey"}
        </Button>
      </ScreenActions>
    </Screen>
  );
}
