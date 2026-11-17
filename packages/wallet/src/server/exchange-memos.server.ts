import { StrKey } from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress } from "../contract";
import { network } from "../stellar/network";

export class KnownExchangeMemo extends Schema.Class<KnownExchangeMemo>(
  "KnownExchangeMemo",
)({
  network: Schema.Literal(network),
  address: AccountAddress.check(
    Schema.makeFilter(StrKey.isValidEd25519PublicKey),
  ),
  exchange: Schema.NonEmptyString,
  source: Schema.String.check(
    Schema.makeFilter(
      (value) => URL.canParse(value) && new URL(value).protocol === "https:",
    ),
  ),
}) {}

export const knownExchangeMemos: ReadonlyArray<KnownExchangeMemo> = [];

export function exchangeMemoFor(
  address: AccountAddress,
  entries: ReadonlyArray<KnownExchangeMemo> = knownExchangeMemos,
): Option.Option<KnownExchangeMemo> {
  return Option.fromNullishOr(
    entries.find((entry) => entry.address === address),
  );
}
