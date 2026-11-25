import { useState } from "react";
import { Button } from "@workspace/ui/components/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@workspace/ui/components/drawer";
import type { WalletClient } from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";

import { useSessionChallenge } from "./session-challenge";
import { sessionLapse } from "./session-lapse";
import { sessionRefusal } from "./session-refusal";
import { unavailableMessage } from "./unavailable";

export function SessionConfirmation({
  client,
  onConfirmed,
  onNoWallet,
}: {
  client: Pick<WalletClient, "sessionChallenge" | "confirmSession">;
  onConfirmed: () => void;
  onNoWallet?: () => void;
}) {
  const { held, refresh } = useSessionChallenge(client);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();

  const confirm = async () => {
    if (!Predicate.isTagged(held, "Ready")) return;

    setConfirming(true);
    setProblem(undefined);

    const outcome = await client.confirmSession(held.challenge);

    setConfirming(false);

    Match.value(outcome).pipe(
      Match.tag("SessionConfirmed", () => {
        sessionLapse.clear();
        onConfirmed();
      }),
      Match.tag("NoWallet", (refused) => {
        if (onNoWallet) {
          onNoWallet();

          return;
        }

        setProblem(sessionRefusal(refused));
      }),
      Match.orElse((refused) => {
        setProblem(sessionRefusal(refused));
        void refresh();
      }),
    );
  };

  const unreachable = Predicate.isTagged(held, "Unreachable")
    ? held
    : undefined;

  return (
    <Drawer open>
      <DrawerContent data-testid="session-confirmation">
        <DrawerHeader>
          <DrawerTitle>Confirma con tu passkey</DrawerTitle>
          <DrawerDescription>
            Necesitamos confirmar que eres tú antes de seguir. Puedes usar tu
            huella, tu rostro o el PIN de tu dispositivo.
          </DrawerDescription>
        </DrawerHeader>
        {unreachable ? (
          <p role="alert" className="px-4 text-body text-destructive">
            {unavailableMessage(unreachable.failure)}
          </p>
        ) : null}
        {problem && !unreachable ? (
          <p role="alert" className="px-4 text-body text-destructive">
            {problem}
          </p>
        ) : null}
        <DrawerFooter>
          {unreachable ? (
            <Button
              className="w-full"
              onClick={() => {
                setProblem(undefined);
                void refresh();
              }}
            >
              Reintentar
            </Button>
          ) : (
            <Button
              className="w-full"
              data-testid="confirm-session"
              disabled={confirming || !Predicate.isTagged(held, "Ready")}
              onClick={confirm}
            >
              {confirming ? "Verificando…" : "Confirmar con passkey"}
            </Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
