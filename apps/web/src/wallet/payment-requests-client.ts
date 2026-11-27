import { makePaymentRequestEffects } from "@workspace/wallet";

import { paymentRequestPort } from "@/requests/payment-requests.functions";

import { deviceKeyStore } from "./client";

export const paymentRequestEffects = makePaymentRequestEffects(
  paymentRequestPort,
  deviceKeyStore,
);
