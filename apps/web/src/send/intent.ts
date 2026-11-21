import {
  DestinationAddress,
  AddressRecipient,
  type Asset,
  PaymentMemo,
  type Recipient,
  TransferIntent,
  Username,
  UsernameRecipient,
  parseAmount,
} from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type Destination = "username" | "address";

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

export const memoByteLimit = 28;

export const memoBytes = (memo: string) =>
  new TextEncoder().encode(memo.trim()).length;

export const recipientOf = (
  destination: Destination,
  typed: string,
): Result.Result<Recipient, FieldProblem> =>
  Match.value(destination).pipe(
    Match.when("username", () =>
      Option.match(Schema.decodeOption(Username)(typed), {
        onNone: () =>
          Result.fail(
            new FieldProblem(
              "recipient",
              "Un @usuario tiene de 3 a 20 letras minúsculas, números o guion bajo",
            ),
          ),
        onSome: (value) => Result.succeed(UsernameRecipient.make({ value })),
      }),
    ),
    Match.when("address", () =>
      Option.match(Schema.decodeOption(DestinationAddress)(typed), {
        onNone: () =>
          Result.fail(
            new FieldProblem(
              "recipient",
              "Una dirección Stellar empieza con G o M",
            ),
          ),
        onSome: (value) => Result.succeed(AddressRecipient.make({ value })),
      }),
    ),
    Match.exhaustive,
  );

const memoOf = (typed: string): Result.Result<PaymentMemo, FieldProblem> => {
  if (memoBytes(typed) > memoByteLimit)
    return Result.fail(new FieldProblem("memo", "El memo es demasiado largo"));

  return Option.match(
    Schema.decodeOption(PaymentMemo)({ type: "id", value: typed }).pipe(
      Option.orElse(() =>
        Schema.decodeOption(PaymentMemo)({ type: "text", value: typed }),
      ),
    ),
    {
      onNone: () =>
        Result.fail(new FieldProblem("memo", "Este memo no es válido")),
      onSome: Result.succeed,
    },
  );
};

export function intentOf(
  form: SendForm,
  destination: Destination,
  asset: Asset,
): Result.Result<TransferIntent, FieldProblem> {
  const to = recipientOf(destination, form.recipient.trim());

  if (Result.isFailure(to)) return Result.fail(to.failure);

  const amount = parseAmount(form.amount.trim().replace(",", "."));

  if (Option.isNone(amount))
    return Result.fail(new FieldProblem("amount", "Escribe un monto válido"));

  const memo = form.memo.trim();

  if (destination === "username" || memo === "")
    return Result.succeed(
      new TransferIntent({ to: to.success, asset, amount: amount.value }),
    );

  return Result.map(
    memoOf(memo),
    (value) =>
      new TransferIntent({
        to: to.success,
        asset,
        amount: amount.value,
        memo: value,
      }),
  );
}
