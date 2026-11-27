import type { Asset, PositiveAmount } from "@workspace/wallet";

import { amountLabel } from "@/send/money";
import { m } from "@/paraglide/messages";

export type ShareResult = "shared" | "copied" | "dismissed" | "failed";

export interface ShareableLink {
  readonly path: string;
  readonly asset: Asset;
  readonly amount: PositiveAmount;
}

const linkUrl = (path: string) => new URL(path, window.location.origin).href;

export const nativeShareAvailable = () => "share" in navigator;

const shareMessage = async (
  title: string,
  message: string,
  path: string,
): Promise<ShareResult> => {
  try {
    await navigator.share({ title, text: `${message}\n\n${linkUrl(path)}` });

    return "shared";
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError"
      ? "dismissed"
      : "failed";
  }
};

export const shareLink = (link: ShareableLink) =>
  shareMessage(
    "Link de pago de Orchid",
    `Te envié ${amountLabel(link.amount, link.asset)} con Orchid. Abre el link para recibirlo.`,
    link.path,
  );

export const sharePaymentRequest = (link: ShareableLink) =>
  shareMessage(
    m.payment_request_message_title(),
    m.payment_request_message({
      amount: amountLabel(link.amount, link.asset),
    }),
    link.path,
  );

export const copyLink = async (link: ShareableLink): Promise<ShareResult> => {
  try {
    await navigator.clipboard.writeText(linkUrl(link.path));

    return "copied";
  } catch {
    return "failed";
  }
};
