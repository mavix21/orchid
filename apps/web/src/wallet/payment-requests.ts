import { type PaymentRequestEffects, loadFromServer } from "@workspace/wallet";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { sessionLapse } from "./session-lapse";

const loaded = loadFromServer(() => import("./payment-requests-client")).pipe(
  Effect.map((client) => client.paymentRequestEffects),
);

const withPaymentRequests = <A>(
  use: (requests: PaymentRequestEffects) => Effect.Effect<A>,
) =>
  loaded.pipe(
    Effect.flatMap(use),
    Effect.catch((failure) => Effect.succeed(failure)),
    Effect.tap((outcome) =>
      Effect.sync(() => {
        if (Predicate.isTagged(outcome, "SessionRequired")) sessionLapse.note();
      }),
    ),
  );

export const paymentRequestEffects: PaymentRequestEffects = {
  create: (request) =>
    withPaymentRequests((requests) => requests.create(request)),
  open: () => withPaymentRequests((requests) => requests.open()),
  cancel: (id) => withPaymentRequests((requests) => requests.cancel(id)),
};
