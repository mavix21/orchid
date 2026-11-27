import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Asset, PositiveAmount, withinAssetMaximum } from "./assets";
import { type AccountAddress, Username } from "./identity";
import type { WalletUnavailable } from "./index";
import { NeedsReopening, NotOpened } from "./standing";

export const paymentRequestIdAlphabet =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const paymentRequestIdLength = 10;

const paymentRequestIdPattern = new RegExp(
  `^[${paymentRequestIdAlphabet}]{${paymentRequestIdLength}}$`,
  "u",
);

export const PaymentRequestId = Schema.String.check(
  Schema.isPattern(paymentRequestIdPattern),
).pipe(Schema.brand("PaymentRequestId"));

export type PaymentRequestId = typeof PaymentRequestId.Type;

export const paymentRequestNoteMaxLength = 100;

export const PaymentRequestNote = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(paymentRequestNoteMaxLength),
  Schema.isTrimmed(),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}]*$/u),
).pipe(Schema.brand("PaymentRequestNote"));

export type PaymentRequestNote = typeof PaymentRequestNote.Type;

const requestedFields = {
  id: PaymentRequestId,
  asset: Asset,
  amount: PositiveAmount,
  note: Schema.optional(PaymentRequestNote),
};

export class NewPaymentRequest extends Schema.Class<NewPaymentRequest>(
  "@workspace/wallet/NewPaymentRequest",
)(Schema.Struct(requestedFields).check(withinAssetMaximum)) {}

const paymentRequestFields = {
  ...requestedFields,
  requester: Username,
  createdAt: Schema.DateTimeUtcFromString,
};

export class PaymentRequestOpen extends Schema.TaggedClass<PaymentRequestOpen>()(
  "PaymentRequestOpen",
  paymentRequestFields,
) {}

export class PaymentRequestPaid extends Schema.TaggedClass<PaymentRequestPaid>()(
  "PaymentRequestPaid",
  paymentRequestFields,
) {}

export class PaymentRequestCancelled extends Schema.TaggedClass<PaymentRequestCancelled>()(
  "PaymentRequestCancelled",
  paymentRequestFields,
) {}

export class PaymentRequestNotFound extends Schema.TaggedClass<PaymentRequestNotFound>()(
  "PaymentRequestNotFound",
  {},
) {}

export class PaymentRequestAssetUnsupported extends Schema.TaggedClass<PaymentRequestAssetUnsupported>()(
  "PaymentRequestAssetUnsupported",
  {},
) {}

export class OpenPaymentRequests extends Schema.TaggedClass<OpenPaymentRequests>()(
  "OpenPaymentRequests",
  { requests: Schema.Array(PaymentRequestOpen) },
) {}

export const CreatePaymentRequestStep = Schema.Union([
  PaymentRequestOpen,
  PaymentRequestPaid,
  PaymentRequestCancelled,
  PaymentRequestAssetUnsupported,
  NotOpened,
  NeedsReopening,
]);

export type CreatePaymentRequestStep = typeof CreatePaymentRequestStep.Type;

export const PaymentRequestStep = Schema.Union([
  PaymentRequestOpen,
  PaymentRequestPaid,
  PaymentRequestCancelled,
  PaymentRequestNotFound,
]);

export type PaymentRequestStep = typeof PaymentRequestStep.Type;

export const OpenPaymentRequestsStep = Schema.Union([
  OpenPaymentRequests,
  NotOpened,
]);

export type OpenPaymentRequestsStep = typeof OpenPaymentRequestsStep.Type;

export const CancelPaymentRequestStep = Schema.Union([
  PaymentRequestCancelled,
  PaymentRequestPaid,
  PaymentRequestNotFound,
  NotOpened,
]);

export type CancelPaymentRequestStep = typeof CancelPaymentRequestStep.Type;

export interface PaymentRequestPort<E = WalletUnavailable> {
  create(
    address: AccountAddress,
    request: NewPaymentRequest,
  ): Effect.Effect<CreatePaymentRequestStep, E>;
  read(id: PaymentRequestId): Effect.Effect<PaymentRequestStep, E>;
  open(address: AccountAddress): Effect.Effect<OpenPaymentRequestsStep, E>;
  cancel(
    address: AccountAddress,
    id: PaymentRequestId,
  ): Effect.Effect<CancelPaymentRequestStep, E>;
}
