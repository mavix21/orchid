import * as Schema from "effect/Schema";
import { Asset, BalanceId, PositiveAmount } from "./assets";
import { AccountAddress } from "./identity";

export const LinkSecret = Schema.String.check(
  Schema.isPattern(/^S[A-Z2-7]{55}$/),
).pipe(Schema.brand("LinkSecret"));

export type LinkSecret = typeof LinkSecret.Type;

export const TransferId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("TransferId"),
);

export type TransferId = typeof TransferId.Type;

export class PaymentLinkReceipt extends Schema.Class<PaymentLinkReceipt>(
  "@workspace/wallet/PaymentLinkReceipt",
)({
  network: Schema.String,
  balance: BalanceId,
  attempts: Schema.Array(BalanceId),
}) {}

export class OpenPaymentLink extends Schema.Class<OpenPaymentLink>(
  "@workspace/wallet/OpenPaymentLink",
)({
  id: TransferId,
  balance: BalanceId,
  address: AccountAddress,
  asset: Asset,
  amount: PositiveAmount,
  createdAt: Schema.DateTimeUtcFromString,
}) {}

export class OpenPaymentLinks extends Schema.TaggedClass<OpenPaymentLinks>()(
  "OpenPaymentLinks",
  {
    links: Schema.Array(OpenPaymentLink),
  },
) {}

export class ResolvedPaymentLink extends Schema.TaggedClass<ResolvedPaymentLink>()(
  "ResolvedPaymentLink",
  {
    balance: BalanceId,
    address: AccountAddress,
    asset: Asset,
    amount: PositiveAmount,
  },
) {}

export class PaymentLinkNotFound extends Schema.TaggedClass<PaymentLinkNotFound>()(
  "PaymentLinkNotFound",
  {},
) {}

export class PaymentLinkReceiptInvalid extends Schema.TaggedClass<PaymentLinkReceiptInvalid>()(
  "PaymentLinkReceiptInvalid",
  {
    reason: Schema.Literals(["wrong_network", "ambiguous"]),
  },
) {}
