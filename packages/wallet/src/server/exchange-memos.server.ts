import { StrKey } from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress } from "../contract";
import { network } from "../stellar/network";

/** Each source must verify this exact address, network and memo requirement. */
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

// Stellar addresses known to need a memo. A send to a listed address without a
// memo returns `ExternalMemoRequired`; every other external address accepts an
// optional memo. An unlisted address is not known to need one: the registry
// does not claim to be complete.
//
// Policy for adding an entry. The schema enforces 1 to 3; reviewers check 4.
// 1. `network` is the network the wallet runs on. A mainnet address never
//    belongs in the testnet registry.
// 2. `address` is the exact, checksum-valid `G…` account address.
// 3. `source` is a public HTTPS URL, and `exchange` names the operator.
// 4. The source is published by the exchange itself (help center, official
//    docs or a SEP-1 `stellar.toml` on its domain), names this exact address,
//    says this network needs a memo there, and is current. Brand-level
//    instructions ("Binance needs a memo") without the address are not enough.
//    Never infer an entry or copy one from a third-party list. Record the date
//    checked in the commit that adds the entry.
//
// Removing an entry needs no evidence. A new entry blocks unsigned drafts to
// that address that have no memo; it never affects an authorized transfer.
//
// Empty: official Binance and Lemon pages describe memo requirements but
// publish no verifiable address list.
export const knownExchangeMemos: ReadonlyArray<KnownExchangeMemo> = [];

export function exchangeMemoFor(
  address: AccountAddress,
  entries: ReadonlyArray<KnownExchangeMemo> = knownExchangeMemos,
): Option.Option<KnownExchangeMemo> {
  return Option.fromNullishOr(
    entries.find((entry) => entry.address === address),
  );
}
