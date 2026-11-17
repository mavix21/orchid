import { sql } from "drizzle-orm";
import * as Schema from "effect/Schema";
import type { AccountAddress } from "../contract";

// A wallet has one signed, unfinished transaction at a time, whichever table
// records it. Both stores take this transaction-level lock before they look
// at either table, so two approvals for one wallet cannot both be stored.
export const walletLock = (address: AccountAddress) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${address}, 0))`;

/** The wallet's slot is held by a signed record the caller's store does not own. */
export class SlotOccupied extends Schema.TaggedClass<SlotOccupied>()(
  "SlotOccupied",
  {},
) {}
