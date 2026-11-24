import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Asset, BalanceId, PositiveAmount } from "./assets";
import { AccountAddress, Profile } from "./identity";

export const LinkSecret = Schema.String.check(
  Schema.isPattern(/^S[A-Z2-7]{55}$/),
).pipe(Schema.brand("LinkSecret"));

export type LinkSecret = typeof LinkSecret.Type;

export const linkCodeVersion = 1;
export const linkCodeEntropyLength = 16;
const linkCodeChecksumLength = 2;
const linkCodeLength = 1 + linkCodeEntropyLength + linkCodeChecksumLength;

const linkCodeChecksum = (body: Uint8Array) =>
  sha256(body).subarray(0, linkCodeChecksumLength);

export const encodeLinkCodeBytes = (entropy: Uint8Array) => {
  const body = Uint8Array.of(linkCodeVersion, ...entropy);

  return base58.encode(Uint8Array.of(...body, ...linkCodeChecksum(body)));
};

const decodeBase58 = Option.liftThrowable(base58.decode);

export const linkCodeEntropy = (text: string): Option.Option<Uint8Array> =>
  decodeBase58(text).pipe(
    Option.filter(
      (bytes) =>
        bytes.length === linkCodeLength &&
        bytes[0] === linkCodeVersion &&
        linkCodeChecksum(bytes.subarray(0, -linkCodeChecksumLength)).every(
          (byte, index) =>
            byte === bytes[linkCodeLength - linkCodeChecksumLength + index],
        ) &&
        base58.encode(bytes) === text,
    ),
    Option.map((bytes) => bytes.slice(1, 1 + linkCodeEntropyLength)),
  );

export const LinkCode = Schema.String.check(
  Schema.makeFilter((text) => Option.isSome(linkCodeEntropy(text))),
).pipe(Schema.brand("LinkCode"));

export type LinkCode = typeof LinkCode.Type;

export const TransferId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("TransferId"),
);

export type TransferId = typeof TransferId.Type;

export class PaymentLinkReceipt extends Schema.Class<PaymentLinkReceipt>(
  "@workspace/wallet/PaymentLinkReceipt",
)({
  network: Schema.String,
  address: AccountAddress,
  asset: Asset,
  amount: PositiveAmount,
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

export class ReceivedPaymentLink extends Schema.Class<ReceivedPaymentLink>(
  "@workspace/wallet/ReceivedPaymentLink",
)({
  id: TransferId,
  address: AccountAddress,
  asset: Asset,
  amount: PositiveAmount,
  receivedAt: Schema.DateTimeUtcFromString,
}) {}

export class OpenPaymentLinks extends Schema.TaggedClass<OpenPaymentLinks>()(
  "OpenPaymentLinks",
  {
    links: Schema.Array(OpenPaymentLink),
    received: Schema.Array(ReceivedPaymentLink),
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

export class PaymentLinkOpen extends Schema.TaggedClass<PaymentLinkOpen>()(
  "PaymentLinkOpen",
  {
    balance: BalanceId,
    asset: Asset,
    amount: PositiveAmount,
    sender: Profile,
  },
) {}

export class PaymentLinkChecking extends Schema.TaggedClass<PaymentLinkChecking>()(
  "PaymentLinkChecking",
  {},
) {}

export class PaymentLinkUsed extends Schema.TaggedClass<PaymentLinkUsed>()(
  "PaymentLinkUsed",
  {},
) {}

export class PaymentLinkUnresolved extends Schema.TaggedClass<PaymentLinkUnresolved>()(
  "PaymentLinkUnresolved",
  {},
) {}
