import {
  Account,
  MuxedAccount,
  extractBaseAddress,
} from "@stellar/stellar-sdk";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type DestinationAddress,
  MuxedAddress,
} from "../contract";

export const isMuxed = Schema.is(MuxedAddress);

export const baseAccountOf = (destination: DestinationAddress) =>
  Schema.decodeSync(AccountAddress)(extractBaseAddress(destination));

const muxedPrefixLength = 52;

export const muxedPrefixOf = (account: AccountAddress) =>
  new MuxedAccount(new Account(account, "0"), "0")
    .accountId()
    .slice(0, muxedPrefixLength);
