import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress } from "../contract";
import { network } from "../stellar/network";
import { fetchEntries } from "./ledger.server";

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

export const memoRequiredDataName = "config.memo_required";

export const sep29Source = "https://stellar.org/protocol/sep-29";

const memoRequiredValue = new xdr.DataValue(new TextEncoder().encode("1"));

export function exchangeMemoFor(
  address: AccountAddress,
  entries: ReadonlyArray<KnownExchangeMemo> = knownExchangeMemos,
): Option.Option<KnownExchangeMemo> {
  return Option.fromNullishOr(
    entries.find((entry) => entry.address === address),
  );
}

export const memoRequirementFor = Effect.fn("Chain.memoRequiredFor")(function* (
  rpcUrl: string,
  address: AccountAddress,
  entries: ReadonlyArray<KnownExchangeMemo> = knownExchangeMemos,
) {
  const known = exchangeMemoFor(address, entries);

  if (Option.isSome(known)) return known;

  const response = yield* fetchEntries(rpcUrl, [
    xdr.LedgerKey.data(
      new xdr.LedgerKeyData({
        accountId: Keypair.fromPublicKey(address).xdrAccountId(),
        dataName: memoRequiredDataName,
      }),
    ),
  ]);

  const published = (response.entries ?? []).some((entry) => {
    const data = xdr.LedgerEntryData.fromXdr(entry.xdr, "base64");

    return (
      data.type === "data" && data.value.dataValue.equals(memoRequiredValue)
    );
  });

  return published
    ? Option.some(
        new KnownExchangeMemo({
          network,
          address,
          exchange: "Exchange",
          source: sep29Source,
        }),
      )
    : Option.none<KnownExchangeMemo>();
});
