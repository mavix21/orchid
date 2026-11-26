import * as Schema from "effect/Schema";
import { addressRules } from "../address-rules";

export const HeldFundsId = Schema.String.check(
  Schema.makeFilter(addressRules.isHeldFundsId),
).pipe(Schema.brand("HeldFundsId"));

export type HeldFundsId = typeof HeldFundsId.Type;
