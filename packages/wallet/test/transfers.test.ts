import { assertTagged } from "./tagged";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Backups } from "../src/server/Backups.server";
import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  AddressRecipient,
  Pending,
  Profile,
  SenderBusy,
  Settled,
  Amount,
} from "../src/contract";
import { Applied, Chain } from "../src/server/Chain.server";
import { Directory, StoreFailure } from "../src/server/Directory.server";
import { walletLock } from "../src/server/slot.server";
import { Concluded, Proposed, Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { approvalMargin, paymentLifetime } from "../src/stellar/network";
import {
  dbLayer,
  world,
  fakeChain,
  settings,
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
      "a signed transfer survives failed submit and sweep finishes without the device",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          world.accounts.set(addressOf(key), {
            sequence: "1000",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("50000000")),
          });

          const order = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const draft = yield* send(order);

          assertTagged(draft, "TransferDraft");

          expect(draft.recipient).toBeInstanceOf(Profile);
          expect(yield* send(order)).toEqual(draft);
          world.failSubmit = true;
          expect(
            yield* send(order, approve(draft.request, key)),
          ).toBeInstanceOf(Pending);

          const stored = Option.getOrThrow(
            yield* Transfers.use((transfers) => transfers.find(order.id)),
          );

          assertTagged(stored, "Authorized");

          world.failSubmit = false;
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(world.submitted.at(-1)?.hash).toBe(stored.sealed.hash);
          world.evidence.set(
            stored.sealed.hash,
            new Applied({ at: DateTime.nowUnsafe() }),
          );
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(yield* send(order)).toBeInstanceOf(Settled);
          expect(
            Option.getOrThrow(
              yield* Transfers.use((transfers) => transfers.find(order.id)),
            ),
          ).toBeInstanceOf(Concluded);
        }),
    );

    it.effect(
      "concurrent approvals allow only one signed transfer per sender",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          world.accounts.set(addressOf(key), {
            sequence: "1000",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("50000000")),
          });

          const to = AddressRecipient.make({ value: addressOf(key) });
          const orders = [orderFor(key, to), orderFor(key, to)];

          const drafts = yield* Effect.all(
            orders.map((order) => send(order)),
            { concurrency: "unbounded" },
          );

          const results = yield* Effect.all(
            orders.map((order, index) => {
              const draft = drafts[index];

              assertTagged(draft, "TransferDraft");

              return send(order, approve(draft.request, key));
            }),
            { concurrency: "unbounded" },
          );

          expect(
            results.filter((result) => result instanceof Pending),
          ).toHaveLength(1);
          expect(
            results.filter((result) => result instanceof SenderBusy),
          ).toHaveLength(1);
          expect(
            yield* Transfers.use((transfers) => transfers.inFlight),
          ).toHaveLength(1);
        }),
    );

    it.effect(
      "same id concurrent approvals keep one immutable sealed envelope",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          world.accounts.set(addressOf(key), {
            sequence: "1000",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("50000000")),
          });

          const order = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const draft = yield* send(order);

          assertTagged(draft, "TransferDraft");

          const results = yield* Effect.all(
            [
              send(order, approve(draft.request, key)),
              send(order, approve(draft.request, key)),
            ],
            { concurrency: "unbounded" },
          );

          expect(results.every((result) => result instanceof Pending)).toBe(
            true,
          );
          expect(
            yield* Transfers.use((transfers) => transfers.inFlight),
          ).toHaveLength(1);
        }),
    );

    it.effect("database failure during authorization submits nothing", () =>
      Effect.gen(function* () {
        const key = Keypair.random();

        yield* create(key, "maria");
        world.accounts.set(addressOf(key), {
          sequence: "1000",
          ledger: 100,
          accountSponsored: true,
          sponsored: true,
          nativeBalance: 0n,
          balance: Option.some(Schema.decodeSync(Amount)("50000000")),
        });

        const order = orderFor(
          key,
          AddressRecipient.make({ value: addressOf(key) }),
        );

        const draft = yield* send(order);

        assertTagged(draft, "TransferDraft");

        const initial = world.submitted.length;

        const brokenTransfers = Layer.effect(
          Transfers,
          Effect.gen(function* () {
            const actual = yield* Transfers;

            return Transfers.of({
              ...actual,
              authorize: () =>
                Effect.fail(
                  new StoreFailure({
                    cause: new Error("Database unavailable"),
                  }),
                ),
            });
          }),
        ).pipe(Layer.provide(Transfers.layer));

        const brokenWallet = Wallet.serviceLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Directory.layer,
              brokenTransfers,
              AssetOrders.layer,
              Backups.layer,
            ),
          ),
          Layer.provide(fakeChain),
          Layer.provide(settings),
          Layer.provide(dbLayer),
        );

        const result = yield* Wallet.use((wallet) =>
          wallet.transfer(order, approve(draft.request, key)),
        ).pipe(Effect.result, Effect.provide(Layer.fresh(brokenWallet)));

        expect(Result.isFailure(result)).toBe(true);
        expect(world.submitted).toHaveLength(initial);
        expect(
          Option.getOrThrow(
            yield* Transfers.use((service) => service.find(order.id)),
          ),
        ).toBeInstanceOf(Proposed);
      }),
    );

    it.effect(
      "authorization keeps a transfer Proposed when waiting on the wallet lock crosses the approval margin",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          world.accounts.set(addressOf(key), {
            sequence: "1000",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("50000000")),
          });

          const order = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const draft = yield* send(order);

          assertTagged(draft, "TransferDraft");

          const stored = Option.getOrThrow(
            yield* Transfers.use((service) => service.find(order.id)),
          );

          assertTagged(stored, "Proposed");

          const sealed = yield* Chain.use((chain) =>
            chain.seal(
              stored.request,
              Option.getOrThrow(approve(stored.request, key)),
              addressOf(key),
            ),
          ).pipe(Effect.provide(fakeChain));

          const db = yield* Database;
          const now = yield* Clock.currentTimeMillis;

          const outcome = yield* Effect.gen(function* () {
            yield* TestClock.setTime(now);

            const lockHeld = yield* Latch.make();
            const releaseLock = yield* Latch.make();

            const holder = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx.execute(walletLock(addressOf(key)));
                  yield* lockHeld.open;
                  yield* releaseLock.await;
                }),
              )
              .pipe(Effect.forkChild);

            yield* lockHeld.await;

            const attempt = yield* Transfers.use((service) =>
              service.authorize(stored, sealed),
            ).pipe(Effect.forkChild);

            while (
              (yield* db.execute(
                sql`select 1 from pg_locks where locktype = 'advisory' and not granted`,
              )).rows.length === 0
            )
              yield* Effect.yieldNow;

            yield* TestClock.adjust(
              Duration.seconds(paymentLifetime - approvalMargin + 1),
            );
            yield* releaseLock.open;
            yield* Fiber.join(holder);

            return yield* Fiber.join(attempt);
          }).pipe(Effect.provide(TestClock.layer()));

          expect(outcome).toBeInstanceOf(Proposed);
          expect(
            Option.getOrThrow(
              yield* Transfers.use((service) => service.find(order.id)),
            ),
          ).toBeInstanceOf(Proposed);
        }),
    );
  },
);
