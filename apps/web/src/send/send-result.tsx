import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import * as Match from "effect/Match";

import { ScreenActions } from "@/components/screen";

import { type SendScreen, outstandingLabel } from "./outcomes";

export function SendResultScreen({
  screen,
  onAgain,
}: {
  screen: SendScreen;
  onAgain: () => void;
}) {
  const home = (label: string) => (
    <Button
      className="w-full"
      nativeButton={false}
      render={<Link to="/home" />}
    >
      {label}
    </Button>
  );

  const again = (label: string) => (
    <Button className="w-full" onClick={onAgain}>
      {label}
    </Button>
  );

  return (
    <>
      <main
        role="status"
        className="flex flex-1 flex-col justify-end gap-2 px-5"
      >
        <h1 className="font-display text-h1">{screen.title}</h1>
        <p className="text-body text-muted-foreground">{screen.message}</p>
        {screen.outstanding === undefined ? null : (
          <p className="text-label-lg">
            {outstandingLabel(screen.outstanding)}
          </p>
        )}
      </main>
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
