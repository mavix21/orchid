import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import * as Match from "effect/Match";

import { ScreenActions, ScreenNote, ScreenStatus } from "@/components/screen";

import { type SendScreen, outstandingLabel } from "./outcomes";

export function SendResultScreen({
  outcome,
  screen,
  onAgain,
}: {
  outcome: string;
  screen: SendScreen;
  onAgain: () => void;
}) {
  const home = (label: string) => (
    <Button
      className="w-full"
      nativeButton={false}
      render={<Link to="/home" data-testid="result-home" />}
    >
      {label}
    </Button>
  );

  const again = (label: string) => (
    <Button className="w-full" onClick={onAgain} data-testid="result-again">
      {label}
    </Button>
  );

  return (
    <>
      <ScreenStatus
        title={screen.title}
        data-testid="send-outcome"
        data-outcome={outcome}
      >
        <ScreenNote>{screen.message}</ScreenNote>
        {screen.outstanding === undefined ? null : (
          <p className="text-label-lg">
            {outstandingLabel(screen.outstanding)}
          </p>
        )}
      </ScreenStatus>
      <ScreenActions>
        {Match.value(screen.action).pipe(
          Match.when("done", () => home("Listo")),
          Match.when("home", () => home("Volver al inicio")),
          Match.when("retry", () => again("Reintentar")),
          Match.when("wait", () => again("Reintentar")),
          Match.when("check", () => again("Ver estado")),
          Match.exhaustive,
        )}
      </ScreenActions>
    </>
  );
}
