import {
  AccountAddress,
  AddressRecipient,
  type Asset,
  PaymentMemo,
  PhoneRecipient,
  type Recipient,
  TransferIntent,
  Username,
  UsernameRecipient,
  parseAmount,
} from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type SendField = "recipient" | "amount" | "memo";

export class FieldProblem {
  constructor(
    readonly field: SendField,
    readonly message: string,
  ) {}
}

export type SendForm = {
  readonly recipient: string;
  readonly amount: string;
  readonly memo: string;
};

const addressPattern = /^G[A-Z2-7]{55}$/;
const phonePattern = /^\+?[0-9][0-9 ]{5,}$/;

export const sendsToAddress = (recipient: string) =>
  addressPattern.test(recipient.trim().toUpperCase());

export function recipientOf(text: string): Option.Option<Recipient> {
  const typed = text.trim();

  if (sendsToAddress(typed))
    return Schema.decodeOption(AccountAddress)(typed.toUpperCase()).pipe(
      Option.map((value) => AddressRecipient.make({ value })),
    );

  if (phonePattern.test(typed))
    return Option.some(
      PhoneRecipient.make({ value: typed.replaceAll(" ", "") }),
    );

  return Schema.decodeOption(Username)(
    typed.replace(/^@/, "").toLowerCase(),
  ).pipe(Option.map((value) => UsernameRecipient.make({ value })));
}

export function memoOf(text: string): Option.Option<PaymentMemo> {
  const typed = text.trim();

  return Schema.decodeOption(PaymentMemo)({ type: "id", value: typed }).pipe(
    Option.orElse(() =>
      Schema.decodeOption(PaymentMemo)({ type: "text", value: typed }),
    ),
  );
}

export function intentOf(
  form: SendForm,
  asset: Asset,
): Result.Result<TransferIntent, FieldProblem> {
  const to = recipientOf(form.recipient);

  if (Option.isNone(to))
    return Result.fail(
      new FieldProblem("recipient", "Escribe un @usuario o una dirección G…"),
    );

  const amount = parseAmount(form.amount.trim().replace(",", "."));

  if (Option.isNone(amount))
    return Result.fail(new FieldProblem("amount", "Escribe un monto válido"));

  const external = Predicate.isTagged(to.value, "Address");

  if (!external || form.memo.trim() === "")
    return Result.succeed(
      new TransferIntent({ to: to.value, asset, amount: amount.value }),
    );

  const memo = memoOf(form.memo);

  return Option.match(memo, {
    onNone: () =>
      Result.fail(
        new FieldProblem(
          "memo",
          "El memo es un número o un texto de hasta 28 caracteres",
        ),
      ),
    onSome: (value) =>
      Result.succeed(
        new TransferIntent({
          to: to.value,
          asset,
          amount: amount.value,
          memo: value,
        }),
      ),
  });
}
