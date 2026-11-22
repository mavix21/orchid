import { useState, useSyncExternalStore } from "react";
import { Button } from "@workspace/ui/components/button";
import * as Match from "effect/Match";

import { Screen, ScreenActions, ScreenNote } from "@/components/screen";
import {
  type EmbeddedApp,
  androidDefaultBrowserLink,
  classifyBrowser,
} from "@/browser/support";

const subscribeToNothing = () => () => {};

const readUserAgent = () => navigator.userAgent;

const unclassifiedOnServer = () => undefined;

export function PasskeyBrowserGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const userAgent = useSyncExternalStore(
    subscribeToNothing,
    readUserAgent,
    unclassifiedOnServer,
  );

  if (userAgent === undefined) return null;

  return Match.valueTags(classifyBrowser(userAgent), {
    Supported: () => children,
    OutdatedIos: () => <OutdatedIosScreen />,
    EmbeddedBrowser: ({ app, platform }) => (
      <EmbeddedBrowserScreen app={app} android={platform === "android"} />
    ),
  });
}

function OutdatedIosScreen() {
  return (
    <Screen>
      <main
        data-testid="outdated-ios"
        className="flex flex-1 flex-col gap-2 px-5 pt-16"
      >
        <h1 className="font-display text-h1 text-balance">
          Este dispositivo no es compatible
        </h1>
        <ScreenNote>
          Orchid necesita iOS 18.4 o más reciente para proteger tu cuenta con
          una passkey. Actualiza desde Ajustes, General, Actualización de
          software.
        </ScreenNote>
      </main>
    </Screen>
  );
}

function EmbeddedBrowserScreen({
  app,
  android,
}: {
  app: EmbeddedApp;
  android: boolean;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "unavailable">(
    "idle",
  );

  const destination = window.location.href;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(destination);
      setCopied("copied");
    } catch {
      setCopied("unavailable");
    }
  };

  return (
    <Screen>
      <main
        data-testid="embedded-browser"
        className="flex flex-1 flex-col gap-4 px-5 pt-16"
      >
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-h1 text-balance">
            Abre Orchid en tu navegador
          </h1>
          <ScreenNote>
            {app} abre los links en un navegador propio que no puede usar
            passkeys, y Orchid las necesita para proteger tu cuenta.
          </ScreenNote>
          <ScreenNote>
            Tu navegador guarda sus datos aparte de {app}: una cuenta creada
            dentro de {app} no aparecerá allá, y si ya tienes una cuenta
            respaldada puedes restaurarla con tu passkey.
          </ScreenNote>
        </div>
        <section className="flex flex-col gap-2">
          <h2 className="text-label-lg">Abrir en el navegador</h2>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-body text-muted-foreground">
            <li>Toca el menú ⋯ o el ícono de compartir de {app}.</li>
            <li>
              Elige «Abrir en el navegador», «Abrir en Safari» o «Abrir en
              Chrome».
            </li>
            <li>
              Si no aparece, copia el link y pégalo en la barra de tu navegador.
            </li>
          </ol>
          <p
            data-testid="embedded-browser-link"
            className="rounded-lg bg-secondary p-3 text-caption break-all select-all"
          >
            {destination}
          </p>
          {copied === "unavailable" ? (
            <p role="alert" className="text-caption text-destructive">
              No pudimos copiarlo. Mantén presionado el link para copiarlo.
            </p>
          ) : null}
        </section>
      </main>
      <ScreenActions>
        {android ? (
          <Button
            className="w-full"
            nativeButton={false}
            render={
              <a
                href={androidDefaultBrowserLink(destination)}
                data-testid="open-in-browser"
              />
            }
          >
            Abrir en el navegador
          </Button>
        ) : null}
        <Button
          className="w-full"
          variant={android ? "ghost" : "default"}
          onClick={copy}
          data-testid="copy-link"
        >
          {copied === "copied" ? "Link copiado" : "Copiar link"}
        </Button>
      </ScreenActions>
    </Screen>
  );
}
