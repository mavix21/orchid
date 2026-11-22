import type { PaymentLinkCreated } from "@workspace/wallet";

import { amountLabel } from "@/send/money";

export type ShareResult = "shared" | "copied" | "dismissed" | "unavailable";

export async function shareLink(
  created: PaymentLinkCreated,
): Promise<ShareResult> {
  const url = new URL(created.path, window.location.origin).href;

  if ("share" in navigator) {
    try {
      await navigator.share({
        title: "Link de pago de Orchid",
        text: `Te envié ${amountLabel(created.amount, created.asset)} con Orchid. Abre el link para recibirlo.`,
        url,
      });

      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        return "dismissed";
    }
  }

  try {
    await navigator.clipboard.writeText(url);

    return "copied";
  } catch {
    return "unavailable";
  }
}
