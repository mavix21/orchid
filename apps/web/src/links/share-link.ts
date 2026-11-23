import type { PaymentLinkCreated } from "@workspace/wallet";
import * as Predicate from "effect/Predicate";

import { amountLabel } from "@/send/money";
import { displayLock } from "@/wallet/display-lock";

export type ShareResult = "shared" | "copied" | "dismissed" | "unavailable";

class HeldUrl {
  constructor(public url: string | undefined) {}

  release() {
    this.url = undefined;
  }
}

const present = async (text: string, held: HeldUrl): Promise<ShareResult> => {
  const stopWatching = displayLock.subscribe(() => {
    if (!Predicate.isTagged(displayLock.state(), "Unlocked")) held.release();
  });

  try {
    if ("share" in navigator) {
      try {
        await navigator.share({
          title: "Link de pago de Orchid",
          text,
          url: held.url,
        });

        return "shared";
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return "dismissed";
      }
    }

    if (held.url === undefined) return "unavailable";

    try {
      await navigator.clipboard.writeText(held.url);

      return "copied";
    } catch {
      return "unavailable";
    }
  } finally {
    stopWatching();
    held.release();
  }
};

export function shareLink(created: PaymentLinkCreated): Promise<ShareResult> {
  if (!Predicate.isTagged(displayLock.state(), "Unlocked"))
    return Promise.resolve("unavailable");

  return present(
    `Te envié ${amountLabel(created.amount, created.asset)} con Orchid. Abre el link para recibirlo.`,
    new HeldUrl(new URL(created.path, window.location.origin).href),
  );
}
