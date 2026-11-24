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
    pairedRecoveryDraft: text(),
    pairedRecoveryEnvelope: text(),
    pairedRecoveryHash: text(),
  },
  (table) => [
    check(
      "wallets_active_has_recovery",
      sql`${table.status} <> 'active' or (${table.recoveryEnvelope} is not null and ${table.recoveryHash} is not null and ${table.recoverySequence} is not null and ${table.recoveryMinTime} is not null and ${table.recoveryMaxTime} is not null)`,
    ),
  ],
);

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

    balanceId: text(),
    claimableKind: text({ enum: ["username", "paymentLink"] }),
    attemptBalanceIds: text(),
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
    index("transfers_hash").on(table.hash),
    check("transfers_positive_amount", sql`${table.amount} > 0`),
    check(
      "transfers_signed_has_hash",
      sql`${table.status} = 'proposed' or ${table.hash} is not null`,
    ),
  ],
);

export const assetOrders = pgTable(
  "asset_orders",
  {
    id: uuid().primaryKey(),
    wallet: text().references(() => wallets.address),
    order: text().notNull(),

    opens: text(),
    balanceId: text(),
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
    linkCleanedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex("asset_orders_one_in_flight")
      .on(table.wallet, table.network, table.testnetEpoch)
      .where(
        sql`${table.status} = 'authorized' and ${table.wallet} is not null`,
      ),
    index("asset_orders_hash").on(table.hash),
    check(
      "asset_orders_signed_has_hash",
      sql`${table.status} = 'proposed' or ${table.hash} is not null`,
    ),
  ],
);

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

export const backups = pgTable("backups", {
  credentialId: text().primaryKey(),
  address: text().notNull(),
  username: text().notNull(),
  publicKey: text().notNull(),
  algorithm: text({ enum: ["ES256", "RS256"] }).notNull(),
  counter: bigint({ mode: "number" }).notNull(),
  iv: text().notNull(),
  ciphertext: text().notNull(),
  enrolledAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const passkeyChallenges = pgTable("passkey_challenges", {
  challenge: text().primaryKey(),
  purpose: text({ enum: ["enrollment", "restore"] }).notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});
