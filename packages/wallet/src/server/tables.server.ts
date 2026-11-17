import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const wallets = pgTable(
  "wallets",
  {
    address: text().primaryKey(),
    status: text({ enum: ["opening", "active", "recovered"] }).notNull(),
    sweepCheckedAt: timestamp({ withTimezone: true }),
    version: integer().notNull().default(0),
    network: text().notNull(),
    testnetEpoch: text().notNull(),
    contractId: text(),
    attemptEnvelope: text(),
    attemptHash: text(),
    attemptExpiresAt: timestamp({ withTimezone: true }),
    recoveryDraft: text(),
    recoveryEnvelope: text(),
    recoveryHash: text(),
    recoverySequence: text(),
    recoveryMinTime: timestamp({ withTimezone: true }),
    recoveryMaxTime: timestamp({ withTimezone: true }),
  },
  (table) => [
    check(
      "wallets_active_has_recovery",
      sql`${table.status} <> 'active' or (${table.recoveryEnvelope} is not null and ${table.recoveryHash} is not null and ${table.recoverySequence} is not null and ${table.recoveryMinTime} is not null and ${table.recoveryMaxTime} is not null)`,
    ),
  ],
);

// Inserted once when the signed opening is stored; never updated or deleted.
export const usernames = pgTable("usernames", {
  username: text().primaryKey(),
  address: text()
    .notNull()
    .unique()
    .references(() => wallets.address),
  boundAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const transfers = pgTable(
  "transfers",
  {
    id: uuid().primaryKey(),
    sender: text()
      .notNull()
      .references(() => wallets.address),
    recipient: text(),
    destination: text().notNull(),
    order: text().notNull(),
    resolvedRecipient: text().notNull(),
    amount: bigint({ mode: "bigint" }).notNull(),
    network: text().notNull(),
    testnetEpoch: text().notNull(),
    contractId: text(),
    status: text({
      enum: ["proposed", "authorized", "settled", "failed"],
    }).notNull(),
    envelope: text().notNull(),
    hash: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    failure: text({ enum: ["expired", "rejected"] }),
    concludedAt: timestamp({ withTimezone: true }),
    sweepCheckedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Set when the transaction creates a claimable balance instead of paying.
    // The row is a lookup hint; whether the balance still exists is read from the ledger.
    balanceId: text(),
    balanceClosedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex("transfers_one_in_flight")
      .on(table.sender, table.network, table.testnetEpoch)
      .where(sql`${table.status} = 'authorized'`),
    index("transfers_open_balances")
      .on(table.balanceId)
      .where(
        sql`${table.balanceId} is not null and ${table.balanceClosedAt} is null`,
      ),
    check("transfers_positive_amount", sql`${table.amount} > 0`),
    check(
      "transfers_signed_has_hash",
      sql`${table.status} = 'proposed' or ${table.hash} is not null`,
    ),
  ],
);

// Trustline and claim transactions. They spend the wallet's sequence number
// like a transfer does, so a wallet has one signed, unfinished record across
// this table and `transfers`; the stores check both under the same lock.
export const assetOrders = pgTable(
  "asset_orders",
  {
    id: uuid().primaryKey(),
    wallet: text()
      .notNull()
      .references(() => wallets.address),
    order: text().notNull(),
    // The trustline a claim opens in the same transaction, when it needs one.
    opens: text(),
    network: text().notNull(),
    testnetEpoch: text().notNull(),
    status: text({
      enum: ["proposed", "authorized", "settled", "failed"],
    }).notNull(),
    envelope: text().notNull(),
    hash: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    failure: text({ enum: ["expired", "rejected"] }),
    concludedAt: timestamp({ withTimezone: true }),
    sweepCheckedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("asset_orders_one_in_flight")
      .on(table.wallet, table.network, table.testnetEpoch)
      .where(sql`${table.status} = 'authorized'`),
    check(
      "asset_orders_signed_has_hash",
      sql`${table.status} = 'proposed' or ${table.hash} is not null`,
    ),
  ],
);

// The trustlines Orchid opened beyond the base asset. RPC cannot list an
// account's trustlines, so these rows say which ledger keys to read; the
// ledger decides whether a trustline exists.
export const trustlines = pgTable(
  "trustlines",
  {
    address: text()
      .notNull()
      .references(() => wallets.address),
    network: text().notNull(),
    testnetEpoch: text().notNull(),
    code: text().notNull(),
    issuer: text().notNull(),
    openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.address,
        table.network,
        table.testnetEpoch,
        table.code,
        table.issuer,
      ],
    }),
  ],
);
