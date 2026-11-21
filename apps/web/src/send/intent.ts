import {
  type AddressNetwork,
  DestinationAddress,
  AddressRecipient,
  MuxedAddress,
  type Asset,
  PaymentMemo,
  type Recipient,
  TransferIntent,
  Username,
  UsernameRecipient,
  parseAmount,
  recogniseAddress,
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

export type MemoType = PaymentMemo["type"];

export type SendForm = {
  readonly recipient: string;
  readonly amount: string;
  readonly memo: string;
  readonly memoType: Option.Option<MemoType>;
};

export const memoByteLimit = 28;

export const memoBytes = (memo: string) =>
  new TextEncoder().encode(memo).length;

const otherNetworkNames: Record<Exclude<AddressNetwork, "stellar">, string> = {
  evm: "una red EVM (como Base o Ethereum)",
  solana: "Solana",
  tron: "Tron",
  bitcoin: "Bitcoin",
};

const addressProblem = (typed: string) =>
  Option.match(recogniseAddress(typed), {
    onNone: () => "La dirección no es válida",
    onSome: (network) =>
      network === "stellar"
        ? "La dirección no es válida"
        : `Esta es una dirección de ${otherNetworkNames[network]}. Por ahora Orchid envía dólares por Stellar. Pídele a quien recibe una dirección de Stellar, o envíale un link de pago.`,
  });

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
          Result.fail(new FieldProblem("recipient", addressProblem(typed))),
        onSome: (value) => Result.succeed(AddressRecipient.make({ value })),
      }),
    ),
    Match.exhaustive,
  );

const memoProblems = {
  type: "Elige cómo aparece el memo en tu exchange",
  tooLong: "El memo es demasiado largo",
  invalidText: "Este memo no es válido",
  invalidId: "Un ID numérico es un número entero de hasta 20 dígitos",
} as const;

const memoOf = (
  typed: string,
  type: Option.Option<MemoType>,
): Result.Result<PaymentMemo, FieldProblem> =>
  Option.match(type, {
    onNone: () => Result.fail(new FieldProblem("memo", memoProblems.type)),
    onSome: (chosen) =>
      chosen === "text" && memoBytes(typed) > memoByteLimit
        ? Result.fail(new FieldProblem("memo", memoProblems.tooLong))
        : Option.match(
            Schema.decodeOption(PaymentMemo)({ type: chosen, value: typed }),
            {
              onNone: () =>
                Result.fail(
                  new FieldProblem(
                    "memo",
                    chosen === "id"
                      ? memoProblems.invalidId
                      : memoProblems.invalidText,
                  ),
                ),
              onSome: Result.succeed,
            },
          ),
  });

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

  if (
    destination === "username" ||
    form.memo === "" ||
    Schema.is(MuxedAddress)(to.success.value)
  )
    return Result.succeed(
      new TransferIntent({ to: to.success, asset, amount: amount.value }),
    );

  return Result.map(
    memoOf(form.memo, form.memoType),
    (value) =>
      new TransferIntent({
        to: to.success,
        asset,
        amount: amount.value,
        memo: value,
      }),
  );
}
