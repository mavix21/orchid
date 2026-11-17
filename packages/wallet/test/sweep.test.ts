import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { makeDatabase } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressRecipient,
  TransferDraft,
  TransferId,
  Amount,
} from "../src/contract";
import { Applied } from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import { Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { sweepBatchSize } from "../src/stellar/network";
import {
  dbLayer,
  world,
  run,
  runStores,
  addressOf,
  approve,
  create,
  orderFor,
  send,
  useDisposableDatabase,
} from "./wallet-harness";

useDisposableDatabase();

test("recovery sweep checks time, balance and sequence before submitting", async () => {
  const key = Keypair.random();
  const claim = await create(key, "maria");
  const initial = world.submitted.length;

  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted).toHaveLength(initial);
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(
        sql`update wallets set "recoveryMinTime" = now() - interval '1 second' where address = ${claim.address}`,
      );
    }).pipe(Effect.provide(dbLayer)),
  );
  world.accounts.set(claim.address, {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("1")),
  });
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted).toHaveLength(initial);
  world.accounts.set(claim.address, {
    sequence: "1001",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("0")),
  });
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted).toHaveLength(initial);
  world.accounts.set(claim.address, {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 1n,
    balance: Option.some(Schema.decodeSync(Amount)("0")),
  });
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted).toHaveLength(initial);
  world.accounts.set(claim.address, {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("0")),
  });
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted).toHaveLength(initial + 1);

  const submitted = world.submitted.at(-1);

  if (!submitted) throw new Error("Expected recovery submission");

  world.evidence.set(submitted.hash, new Applied({ at: DateTime.nowUnsafe() }));
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(
    (
      await runStores(
        Directory.use((directory) => directory.byAddress(claim.address)),
      )
    ).pipe(Option.map((row) => row.status)),
  ).toEqual(Option.some("recovered"));
});

test("recovery queue excludes future and expired windows, caps and rotates eligible work", async () => {
  const addresses = new Array<AccountAddress>();

  for (let index = 0; index < sweepBatchSize + 2; index++) {
    const key = Keypair.random();
    const claim = await create(key, `user_${index}`);

    addresses.push(claim.address);
  }

  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(
        sql`update wallets set "recoveryMinTime" = now() - interval '1 minute', "recoveryMaxTime" = now() + interval '1 hour'`,
      );
      yield* db.execute(
        sql`update wallets set "recoveryMinTime" = now() + interval '1 hour', "recoveryMaxTime" = now() + interval '2 hours' where address = ${addresses[0]}`,
      );
      yield* db.execute(
        sql`update wallets set "recoveryMaxTime" = now() - interval '1 second' where address = ${addresses[1]}`,
      );
    }).pipe(Effect.provide(dbLayer)),
  );

  const first = await runStores(
    Directory.use((directory) => directory.recoverable),
  );

  expect(first).toHaveLength(sweepBatchSize);
  expect(
    first.some(
      (row) => row.address === addresses[0] || row.address === addresses[1],
    ),
  ).toBe(false);
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(
        sql`update wallets set "recoveryMinTime" = now() - interval '1 minute', "recoveryMaxTime" = now() + interval '1 hour' where address = ${addresses[0]}`,
      );
    }).pipe(Effect.provide(dbLayer)),
  );

  const second = await runStores(
    Directory.use((directory) => directory.recoverable),
  );

  expect(second).toHaveLength(sweepBatchSize);
  expect(second.some((row) => row.address === addresses[0])).toBe(true);
});

test("transfer sweep queue caps and rotates signed work across senders", async () => {
  const ids = new Array<TransferId>();

  for (let index = 0; index < sweepBatchSize + 1; index++) {
    const key = Keypair.random();

    await create(key, `sender_${index}`);
    world.accounts.set(addressOf(key), {
      sequence: "1000",
      nativeBalance: 0n,
      balance: Option.some(Schema.decodeSync(Amount)("50000000")),
      ledger: 100,
      accountSponsored: true,
      sponsored: true,
    });

    const order = orderFor(
      key,
      AddressRecipient.make({ value: addressOf(key) }),
    );

    const draft = await send(order);

    if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

    await send(order, approve(draft.request, key));
    ids.push(order.id);
  }

  const first = await runStores(Transfers.use((service) => service.inFlight));
  const next = await runStores(Transfers.use((service) => service.inFlight));

  const seen = new Set(
    [...first, ...next].map((transfer) => transfer.order.id),
  );

  expect(first).toHaveLength(sweepBatchSize);
  expect(next).toHaveLength(sweepBatchSize);
  expect(seen.size).toBe(ids.length);
});
