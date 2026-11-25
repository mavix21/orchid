import { useEffect, useState } from "react";

import {
  expireHumanCheck,
  mountHumanCheck,
  offerHumanCheck,
  onHumanCheckTaken,
} from "@/wallet/human-check";
import { humanCheckSiteKeyFn } from "@/wallet/human-check.functions";

interface TurnstileOptions {
  readonly sitekey: string;
  readonly appearance: "interaction-only";
  readonly language: "es";
  readonly callback: (token: string) => void;
  readonly "expired-callback": () => void;
  readonly "timeout-callback": () => void;
  readonly "error-callback": () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    readonly turnstile?: TurnstileApi;
  }
}

const turnstileScript =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<TurnstileApi> | undefined;

const loadTurnstile = () => {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");

    script.src = turnstileScript;
    script.async = true;
    script.addEventListener("load", () => {
      if (window.turnstile) {
        resolve(window.turnstile);

        return;
      }

      loading = undefined;
      reject(new Error("Turnstile did not initialize"));
    });
    script.addEventListener("error", () => {
      loading = undefined;
      reject(new Error("Turnstile did not load"));
    });
    document.head.appendChild(script);
  });

  return loading;
};

export function HumanCheckWidget() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (host === null) return;

    let active = true;
    let widgetId: string | undefined;
    let release = () => {};
    const unmount = mountHumanCheck();

    void Promise.all([humanCheckSiteKeyFn(), loadTurnstile()])
      .then(([sitekey, turnstile]) => {
        if (!active) return;

        widgetId = turnstile.render(host, {
          sitekey,
          appearance: "interaction-only",
          language: "es",
          callback: offerHumanCheck,
          "expired-callback": expireHumanCheck,
          "timeout-callback": expireHumanCheck,
          "error-callback": expireHumanCheck,
        });

        release = onHumanCheckTaken(() => {
          if (widgetId !== undefined) turnstile.reset(widgetId);
        });
      })
      .catch(() => {
        unmount();

        if (active) setUnavailable(true);
      });

    return () => {
      active = false;
      release();
      unmount();
      expireHumanCheck();

      if (widgetId !== undefined) window.turnstile?.remove(widgetId);
    };
  }, [host]);

  return (
    <div className="flex flex-col items-center">
      <div ref={setHost} />
      {unavailable ? (
        <p role="alert" className="px-5 pb-3 text-body text-destructive">
          No pudimos cargar la verificación de seguridad. Recarga la página.
        </p>
      ) : null}
    </div>
  );
}
