import {
  type AddressNetwork,
  DestinationAddress,
  ExternalLinkIntent,
  PaymentMemo,
  forbidsMemo,
  recogniseAddress,
} from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { memoByteLimit, memoBytes } from "@/send/intent";

export type ExternalClaimField = "destination" | "memo";

export class ExternalClaimFieldProblem {
  constructor(
    readonly field: ExternalClaimField,
    readonly message: string,
  ) {}
}

export interface ExternalClaimForm {
  readonly destination: string;
  readonly memo: string;
}

const otherNetworkNames: Record<Exclude<AddressNetwork, "stellar">, string> = {
  evm: "una red EVM (como Base o Ethereum)",
  solana: "Solana",
  tron: "Tron",
  bitcoin: "Bitcoin",
};

const destinationProblem = (typed: string) =>
  Option.match(recogniseAddress(typed), {
    onNone: () => "La dirección no es válida",
    onSome: (network) =>
      network === "stellar"
        ? "La dirección no es válida"
        : `Esta es una dirección de ${otherNetworkNames[network]}. Este link solo se puede enviar a una dirección de Stellar.`,
  });

export function externalClaimIntentOf(
  form: ExternalClaimForm,
): Result.Result<ExternalLinkIntent, ExternalClaimFieldProblem> {
  const typed = form.destination.trim();
  const decoded = Schema.decodeOption(DestinationAddress)(typed);

  if (
    Option.isNone(decoded) ||
    !Option.contains(recogniseAddress(typed), "stellar")
  )
    return Result.fail(
      new ExternalClaimFieldProblem("destination", destinationProblem(typed)),
    );

  const destination = decoded.value;

  if (forbidsMemo(destination))
    return Result.succeed(new ExternalLinkIntent({ destination }));

  const trimmed = form.memo.trim();

  if (trimmed === "")
    return Result.succeed(new ExternalLinkIntent({ destination }));

  if (memoBytes(trimmed) > memoByteLimit)
    return Result.fail(
      new ExternalClaimFieldProblem(
        "memo",
        "El memo es demasiado largo. Vuelve a copiarlo completo desde la app que recibe.",
      ),
    );

  return Option.match(
    Schema.decodeOption(PaymentMemo)({ type: "text", value: trimmed }),
    {
      onNone: () =>
        Result.fail(
          new ExternalClaimFieldProblem("memo", "Este memo no es válido"),
        ),
      onSome: (memo) =>
        Result.succeed(new ExternalLinkIntent({ destination, memo })),
    },
  );
}
