import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import * as Match from "effect/Match";

import { ScreenActions } from "@/components/screen";

import type { LinkScreen } from "./outcomes";

export function LinkWorking({ label, note }: { label: string; note?: string }) {
  return (
    <main
      role="status"
      className="flex flex-1 flex-col justify-end gap-2 px-5 pb-30"
    >
      <h1 className="font-display text-h1">{label}</h1>
      {note === undefined ? null : (
        <p className="text-body text-muted-foreground">{note}</p>
      )}
    </main>
  );
}

export function LinkResultScreen({
  outcome,
  screen,
  onAgain,
  onEdit,
  onCheck,
  onDone,
}: {
  outcome: string;
  screen: LinkScreen;
  onAgain: () => void;
  onEdit: () => void;
  onCheck: () => void;
  onDone?: () => void;
}) {
  const go = (label: string, link: React.ReactElement) => (
    <Button
      className="w-full"
      nativeButton={false}
      render={link}
      data-testid="link-result-action"
    >
      {label}
    </Button>
  );

  const act = (label: string, onClick: () => void) => (
    <Button
      className="w-full"
      onClick={onClick}
      data-testid="link-result-action"
    >
      {label}
    </Button>
  );

  return (
    <>
      <main
        role="status"
        data-testid="link-outcome"
        data-outcome={outcome}
        className="flex flex-1 flex-col justify-end gap-2 px-5"
      >
        <h1 className="font-display text-h1">{screen.title}</h1>
        <p className="text-body text-muted-foreground">{screen.message}</p>
      </main>
      <ScreenActions>
        {Match.value(screen.action).pipe(
          Match.when("done", () =>
            onDone === undefined
              ? go("Listo", <Link to="/home" />)
              : act("Listo", onDone),
          ),
          Match.when("home", () => go("Volver al inicio", <Link to="/home" />)),
          Match.when("again", () => act("Reintentar", onAgain)),
          Match.when("edit", () => act("Cambiar monto", onEdit)),
          Match.when("check", () => act("Revisar de nuevo", onCheck)),
          Match.when("links", () => go("Ver mis links", <Link to="/links" />)),
          Match.when("assets", () =>
            go("Elegir otro activo", <Link to="/send" />),
          ),
          Match.exhaustive,
        )}
      </ScreenActions>
    </>
  );
}
