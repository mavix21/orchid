import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import * as Match from "effect/Match";

import { ScreenActions, ScreenNote, ScreenStatus } from "@/components/screen";

import type { LinkScreen } from "./outcomes";

export function LinkWorking({ label, note }: { label: string; note?: string }) {
  return (
    <ScreenStatus title={label}>
      {note === undefined ? null : <ScreenNote>{note}</ScreenNote>}
    </ScreenStatus>
  );
}

export function LinkResultScreen({
  outcome,
  screen,
  onAgain,
  onEdit,
  onCheck,
  onElsewhere,
  onDone,
}: {
  outcome: string;
  screen: LinkScreen;
  onAgain: () => void;
  onEdit: () => void;
  onCheck: () => void;
  onElsewhere?: () => void;
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
      <ScreenStatus
        title={screen.title}
        data-testid="link-outcome"
        data-outcome={outcome}
      >
        <ScreenNote>{screen.message}</ScreenNote>
      </ScreenStatus>
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
            go("Elegir otra moneda", <Link to="/send" />),
          ),
          Match.when("elsewhere", () => (
            <>
              {onElsewhere === undefined
                ? null
                : act("Enviar de otra forma", onElsewhere)}
              <Button
                className="w-full"
                variant="secondary"
                nativeButton={false}
                render={<Link to="/send" />}
              >
                Elegir otra moneda
              </Button>
            </>
          )),
          Match.exhaustive,
        )}
      </ScreenActions>
    </>
  );
}
