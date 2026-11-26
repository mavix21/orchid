import { Keypair } from "@stellar/stellar-sdk";
import * as Schema from "effect/Schema";
import { Amount } from "../src/contract";
import { issuedAsset } from "../src/stellar/assets";
import { addressOf } from "./device-fixtures";

const amount = (value: string) => Schema.decodeSync(Amount)(value);

export const euro = issuedAsset("EUR", addressOf(Keypair.random()));

export const euroLine = (
  balance: string,
  overrides: { readonly capacity?: Amount } = {},
) => ({
  asset: euro,
  balance: amount(balance),
  spendable: amount(balance),
  capacity: overrides.capacity ?? amount("9223372036854775807"),
  authorized: true,
  clawbackEnabled: false,
  sponsored: true,
});
