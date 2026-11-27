import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  type CancelPaymentRequestStep,
  type CreatePaymentRequestStep,
  type NewPaymentRequest,
  type OpenPaymentRequestsStep,
  PaymentRequestId,
  type PaymentRequestPort,
  type WalletUnavailable,
  paymentRequestIdAlphabet,
  paymentRequestIdLength,
} from "../contract";
import type { KeyStore } from "./key-store";
import { NoWallet, UnsupportedDevice } from "./outcomes";

const byteValues = 256;

const unbiasedByteLimit =
  byteValues - (byteValues % paymentRequestIdAlphabet.length);

export function newPaymentRequestId(): PaymentRequestId {
  let drawn = "";

  while (drawn.length < paymentRequestIdLength)
    for (const byte of crypto.getRandomValues(
      new Uint8Array(paymentRequestIdLength - drawn.length),
    ))
      if (byte < unbiasedByteLimit)
        drawn += paymentRequestIdAlphabet.charAt(
          byte % paymentRequestIdAlphabet.length,
        );

  return Schema.decodeSync(PaymentRequestId)(drawn);
}

type DeviceRefusal = NoWallet | UnsupportedDevice | WalletUnavailable;

export type CreatePaymentRequestOutcome =
  | CreatePaymentRequestStep
  | DeviceRefusal;

export type OpenPaymentRequestsOutcome =
  | OpenPaymentRequestsStep
  | DeviceRefusal;

export type CancelPaymentRequestOutcome =
  | CancelPaymentRequestStep
  | DeviceRefusal;

export interface PaymentRequestEffects {
  create(
    request: NewPaymentRequest,
  ): Effect.Effect<CreatePaymentRequestOutcome>;
  open(): Effect.Effect<OpenPaymentRequestsOutcome>;
  cancel(id: PaymentRequestId): Effect.Effect<CancelPaymentRequestOutcome>;
}

export function makePaymentRequestEffects(
  port: PaymentRequestPort,
  keyStore: KeyStore,
): PaymentRequestEffects {
  const asRequester = <A>(
    ask: (address: AccountAddress) => Effect.Effect<A, WalletUnavailable>,
  ) =>
    Effect.gen(function* () {
      const saved = yield* keyStore.readPublic();

      if (Option.isNone(saved)) return new NoWallet();

      return yield* ask(saved.value.address);
    }).pipe(
      Effect.catchTag("KeyStoreUnavailable", () =>
        Effect.succeed(new UnsupportedDevice()),
      ),
      Effect.catch((failure) => Effect.succeed(failure)),
    );

  return {
    create: (request) =>
      asRequester((address) => port.create(address, request)),
    open: () => asRequester((address) => port.open(address)),
    cancel: (id) => asRequester((address) => port.cancel(address, id)),
  };
}
