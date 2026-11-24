import type { Asset, PositiveAmount } from "@workspace/wallet";
import * as Predicate from "effect/Predicate";

import { amountLabel } from "@/send/money";
import { displayLock } from "@/wallet/display-lock";

export type ShareResult = "shared" | "copied" | "dismissed" | "failed";

export interface ShareableLink {
  readonly path: string;
  readonly asset: Asset;
  readonly amount: PositiveAmount;
}

const whileUnlocked = (
  link: ShareableLink,
  deliver: (url: string) => Promise<ShareResult>,
): Promise<ShareResult> =>
  Predicate.isTagged(displayLock.state(), "Unlocked")
    ? deliver(new URL(link.path, window.location.origin).href)
    : Promise.resolve("failed");

export const nativeShareAvailable = () => "share" in navigator;

export const shareLink = (link: ShareableLink) =>
  whileUnlocked(link, async (url) => {
    try {
      await navigator.share({
        title: "Link de pago de Orchid",
        text: `Te envié ${amountLabel(link.amount, link.asset)} con Orchid. Abre el link para recibirlo.\n\n${url}`,
      });

      return "shared";
    } catch (error) {
      return error instanceof DOMException && error.name === "AbortError"
        ? "dismissed"
        : "failed";
    }
  });

export const copyLink = (link: ShareableLink) =>
  whileUnlocked(link, async (url) => {
    try {
      await navigator.clipboard.writeText(url);

      return "copied";
    } catch {
      return "failed";
    }
  });
