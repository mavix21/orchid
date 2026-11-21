import { assertTagged } from "./tagged";
import { sql } from "drizzle-orm";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Backups } from "../src/server/Backups.server";
import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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
import {
  dbLayer,
  world,
  fakeChain,
  settings,
  addressOf,
  approve,
  create,
  orderFor,
  runAcrossLockWait,
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

    const lockCases: ReadonlyArray<{
      readonly name: string;
      readonly locktype: "advisory" | "relation";
      readonly lock: (
        address: ReturnType<typeof addressOf>,
      ) => ReturnType<typeof walletLock>;
    }> = [
      {
        name: "the wallet advisory lock",
        locktype: "advisory",
        lock: walletLock,
      },
      {
        name: "the post-lock slot query",
        locktype: "relation",
        lock: () => sql`lock table asset_orders in access exclusive mode`,
      },
    ];

    it.effect.each(lockCases)(
      "authorization keeps a transfer Proposed when waiting on $name crosses the approval margin",
      ({ locktype, lock }) =>
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

          assertTagged(yield* send(order), "TransferDraft");

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

          const { result: outcome } = yield* runAcrossLockWait({
            locktype,
            advance: "101 seconds",
            acquire: (tx) => tx.execute(lock(addressOf(key))),
            run: Transfers.use((service) => service.authorize(stored, sealed)),
          });

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
