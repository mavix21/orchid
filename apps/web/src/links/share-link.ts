import type { Asset, PositiveAmount } from "@workspace/wallet";

import { amountLabel } from "@/send/money";

export type ShareResult = "shared" | "copied" | "dismissed" | "failed";

export interface ShareableLink {
  readonly path: string;
  readonly asset: Asset;
  readonly amount: PositiveAmount;
}

const linkUrl = (link: ShareableLink) =>
  new URL(link.path, window.location.origin).href;

export const nativeShareAvailable = () => "share" in navigator;

export const shareLink = async (link: ShareableLink): Promise<ShareResult> => {
  try {
    await navigator.share({
      title: "Link de pago de Orchid",
      text: `Te envié ${amountLabel(link.amount, link.asset)} con Orchid. Abre el link para recibirlo.\n\n${linkUrl(link)}`,
    });

    return "shared";
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError"
      ? "dismissed"
      : "failed";
  }
};

export const copyLink = async (link: ShareableLink): Promise<ShareResult> => {
  try {
    await navigator.clipboard.writeText(linkUrl(link));

    return "copied";
  } catch {
    return "failed";
  }
};
