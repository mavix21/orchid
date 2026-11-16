import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const wallets = pgTable(
  "wallets",
  {
    address: text().primaryKey(),
    username: text().notNull().unique(),
    status: text({ enum: ["claimed", "opening", "active", "recovered"] }).notNull(),
    version: integer().notNull().default(0),
    network: text().notNull(),
    testnetEpoch: text().notNull(),
    contractId: text(),
    claimedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
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
    status: text({ enum: ["proposed", "authorized", "settled", "failed"] }).notNull(),
    envelope: text().notNull(),
    hash: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    failure: text({ enum: ["expired", "rejected"] }),
    concludedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("transfers_one_in_flight")
      .on(table.sender, table.network, table.testnetEpoch)
      .where(sql`${table.status} = 'authorized'`),
    check("transfers_positive_amount", sql`${table.amount} > 0`),
    check(
      "transfers_signed_has_hash",
      sql`${table.status} = 'proposed' or ${table.hash} is not null`,
    ),
  ],
);
