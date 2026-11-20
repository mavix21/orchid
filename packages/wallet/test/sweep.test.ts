import { assertTagged } from "./tagged";
import { expect, layer } from "@effect/vitest";
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
  addressOf,
  approve,
  create,
  orderFor,
  send,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "recovery sweep checks time, balance and sequence before submitting",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = yield* create(key, "maria");
          const initial = world.submitted.length;

          yield* Wallet.use((wallet) => wallet.sweep);
          expect(world.submitted).toHaveLength(initial);
          yield* Effect.gen(function* () {
            const db = yield* makeDatabase();

            yield* db.execute(
              sql`update wallets set "recoveryMinTime" = now() - interval '1 second' where address = ${claim.address}`,
            );
          }).pipe(Effect.provide(dbLayer));
          world.accounts.set(claim.address, {
            sequence: "1000",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("1")),
          });
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(world.submitted).toHaveLength(initial);
          world.accounts.set(claim.address, {
            sequence: "1001",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("0")),
          });
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(world.submitted).toHaveLength(initial);
          world.accounts.set(claim.address, {
            sequence: "1000",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 1n,
            balance: Option.some(Schema.decodeSync(Amount)("0")),
          });
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(world.submitted).toHaveLength(initial);
          world.accounts.set(claim.address, {
            sequence: "1000",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("0")),
          });
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(world.submitted).toHaveLength(initial + 1);

          const submitted = world.submitted.at(-1);

          if (!submitted) throw new Error("Expected recovery submission");

          world.evidence.set(
            submitted.hash,
            new Applied({ at: DateTime.nowUnsafe() }),
          );
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(
            (yield* Directory.use((directory) =>
              directory.byAddress(claim.address),
            )).pipe(Option.map((row) => row.status)),
          ).toEqual(Option.some("recovered"));
        }),
    );

    it.effect(
      "recovery queue excludes future and expired windows, caps and rotates eligible work",
      () =>
        Effect.gen(function* () {
          const addresses = new Array<AccountAddress>();

          for (let index = 0; index < sweepBatchSize + 2; index++) {
            const key = Keypair.random();
            const claim = yield* create(key, `user_${index}`);

            addresses.push(claim.address);
          }

          yield* Effect.gen(function* () {
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
          }).pipe(Effect.provide(dbLayer));

          const first = yield* Directory.use(
            (directory) => directory.recoverable,
          );

          expect(first).toHaveLength(sweepBatchSize);
          expect(
            first.some(
              (row) =>
                row.address === addresses[0] || row.address === addresses[1],
            ),
          ).toBe(false);
          yield* Effect.gen(function* () {
            const db = yield* makeDatabase();

            yield* db.execute(
              sql`update wallets set "recoveryMinTime" = now() - interval '1 minute', "recoveryMaxTime" = now() + interval '1 hour' where address = ${addresses[0]}`,
            );
          }).pipe(Effect.provide(dbLayer));

          const second = yield* Directory.use(
            (directory) => directory.recoverable,
          );

          expect(second).toHaveLength(sweepBatchSize);
          expect(second.some((row) => row.address === addresses[0])).toBe(true);
        }),
    );

    it.effect(
      "transfer sweep queue caps and rotates signed work across senders",
      () =>
        Effect.gen(function* () {
          const ids = new Array<TransferId>();

          for (let index = 0; index < sweepBatchSize + 1; index++) {
            const key = Keypair.random();

            yield* create(key, `sender_${index}`);
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

            const draft = yield* send(order);

            assertTagged(draft, "TransferDraft");

            yield* send(order, approve(draft.request, key));
            ids.push(order.id);
          }

          const first = yield* Transfers.use((service) => service.inFlight);
          const next = yield* Transfers.use((service) => service.inFlight);

          const seen = new Set(
            [...first, ...next].map((transfer) => transfer.order.id),
          );

          expect(first).toHaveLength(sweepBatchSize);
          expect(next).toHaveLength(sweepBatchSize);
          expect(seen.size).toBe(ids.length);
        }),
    );
  },
);
