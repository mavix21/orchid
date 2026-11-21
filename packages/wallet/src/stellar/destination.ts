import { extractBaseAddress } from "@stellar/stellar-sdk";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type DestinationAddress,
  MuxedAddress,
} from "../contract";

export const isMuxed = Schema.is(MuxedAddress);

export const baseAccountOf = (destination: DestinationAddress) =>
  Schema.decodeSync(AccountAddress)(extractBaseAddress(destination));
