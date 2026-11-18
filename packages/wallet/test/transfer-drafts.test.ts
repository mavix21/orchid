import { AssetOrders } from "../src/server/AssetOrders.server";
import { Backups } from "../src/server/Backups.server";
import { expect, layer } from "@effect/vitest";
import {
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { makeDatabase } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  AddressRecipient,
  ExternalRecipient,
  Failed,
  Holding,
  Pending,
  PositiveAmount,
  Settled,
  TransferDraft,
  TransferOrder,
  Amount,
} from "../src/contract";
import { Applied, Chain, Rejected } from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import {
  Authorized,
  Proposed,
  SlotTaken,
  Transfers,
} from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { networkPassphrase } from "../src/stellar/network";
import {
  dbLayer,
  stores,
  world,
  fakeChain,
  settings,
  walletLayer,
  addressOf,
  approve,
  create,
  orderFor,
  send,
  fundHolder,
  paymentSequence,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "near-expiry unsigned drafts refresh, while authorized bytes never change",
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

          yield* send(order);
          yield* Effect.gen(function* () {
            const db = yield* makeDatabase();

            yield* db.execute(
              sql`update transfers set "expiresAt" = now() + interval '10 seconds' where id = ${order.id}`,
            );
          }).pipe(Effect.provide(dbLayer));

          const refreshed = yield* send(order);

          if (!(refreshed instanceof TransferDraft))
            throw new Error("Expected refreshed draft");

          expect(
            DateTime.toEpochMillis(refreshed.request.expiresAt),
          ).toBeGreaterThan(Date.now() + 20000);
          yield* send(order, approve(refreshed.request, key));

          const authorized = Option.getOrThrow(
            yield* Transfers.use((service) => service.find(order.id)),
          );

          if (!(authorized instanceof Authorized))
            throw new Error("Expected authorization");

          const competing = yield* Transfers.use((service) =>
            service.propose(
              order,
              new ExternalRecipient({ address: addressOf(Keypair.random()) }),
              refreshed.request,
            ),
          );

          expect(competing).toEqual(authorized);

          const changed = new TransferOrder({
            ...order,
            amount: Schema.decodeSync(PositiveAmount)("20000000"),
          });

          const refused = yield* Wallet.use((wallet) =>
            wallet.transfer(changed, Option.none()),
          ).pipe(Effect.result, Effect.provide(walletLayer));

          expect(Result.isFailure(refused)).toBe(true);
          expect(
            Option.getOrThrow(
              yield* Transfers.use((service) => service.find(order.id)),
            ),
          ).toEqual(authorized);
        }),
    );

    it.effect(
      "double tap redrafts a still-live stale sequence before accepting its approval",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          fundHolder(key);

          const orders = [
            orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
            orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
          ];

          const first = orders[0];
          const second = orders[1];

          if (!first || !second) throw new Error("Expected two orders");

          const firstDraft = yield* send(first);
          const secondDraft = yield* send(second);

          if (
            !(firstDraft instanceof TransferDraft) ||
            !(secondDraft instanceof TransferDraft)
          )
            throw new Error("Expected drafts");

          expect(paymentSequence(firstDraft)).toBe("1001");
          expect(paymentSequence(secondDraft)).toBe("1001");
          yield* send(first, approve(firstDraft.request, key));

          const signed = Option.getOrThrow(
            yield* Transfers.use((service) => service.find(first.id)),
          );

          if (!(signed instanceof Authorized))
            throw new Error("Expected authorization");

          fundHolder(key, "1001");
          world.evidence.set(
            signed.sealed.hash,
            new Applied({ at: DateTime.nowUnsafe() }),
          );
          expect(yield* send(first)).toBeInstanceOf(Settled);

          const redrafted = yield* send(
            second,
            approve(secondDraft.request, key),
          );

          if (!(redrafted instanceof TransferDraft))
            throw new Error("Expected redraft");

          expect(paymentSequence(redrafted)).toBe("1002");
          expect(
            Option.getOrThrow(
              yield* Transfers.use((service) => service.find(second.id)),
            ),
          ).toBeInstanceOf(Proposed);
          expect(
            yield* send(second, approve(redrafted.request, key)),
          ).toBeInstanceOf(Pending);
        }),
    );

    it.effect(
      "SlotTaken reconciliation refreshes the waiting draft after the holder consumes its sequence",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          fundHolder(key);

          const first = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const second = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const firstDraft = yield* send(first);
          const secondDraft = yield* send(second);

          if (
            !(firstDraft instanceof TransferDraft) ||
            !(secondDraft instanceof TransferDraft)
          )
            throw new Error("Expected drafts");

          yield* send(first, approve(firstDraft.request, key));

          const finishing = Layer.effect(
            Transfers,
            Effect.gen(function* () {
              const actual = yield* Transfers;

              return Transfers.of({
                ...actual,
                authorize: (proposal, sealed) =>
                  Effect.gen(function* () {
                    const result = yield* actual.authorize(proposal, sealed);

                    if (result instanceof SlotTaken) {
                      fundHolder(key, "1001");
                      world.evidence.set(
                        result.holder.sealed.hash,
                        new Applied({ at: DateTime.nowUnsafe() }),
                      );
                    }

                    return result;
                  }),
              });
            }),
          ).pipe(Layer.provide(Transfers.layer));

          const finishingWallet = Wallet.serviceLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Directory.layer,
                finishing,
                AssetOrders.layer,
                Backups.layer,
              ),
            ),
            Layer.provide(fakeChain),
            Layer.provide(settings),
            Layer.provide(dbLayer),
          );

          const result = yield* Wallet.use((wallet) =>
            wallet.transfer(second, approve(secondDraft.request, key)),
          ).pipe(Effect.provide(Layer.fresh(finishingWallet)));

          if (!(result instanceof TransferDraft))
            throw new Error("Expected redraft");

          expect(paymentSequence(result)).toBe("1002");
          expect(
            yield* send(second, approve(result.request, key)),
          ).toBeInstanceOf(Pending);
        }),
    );

    it.effect(
      "a proven consumed authorization concludes and releases the sender slot",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          fundHolder(key);

          const order = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const draft = yield* send(order);

          if (!(draft instanceof TransferDraft))
            throw new Error("Expected draft");

          yield* send(order, approve(draft.request, key));

          const signed = Option.getOrThrow(
            yield* Transfers.use((service) => service.find(order.id)),
          );

          if (!(signed instanceof Authorized))
            throw new Error("Expected authorization");

          fundHolder(key, "1001");
          world.evidence.set(
            signed.sealed.hash,
            new Rejected({ code: "sequence_consumed" }),
          );
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(yield* send(order)).toBeInstanceOf(Failed);
          expect(
            yield* Transfers.use((service) => service.inFlight),
          ).toHaveLength(0);

          const next = yield* send(
            orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
          );

          if (!(next instanceof TransferDraft))
            throw new Error("Expected next draft");

          expect(paymentSequence(next)).toBe("1002");
        }),
    );

    it.effect(
      "an unsigned newer draft cannot hide the latest authorized or settled receipt",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          fundHolder(key);

          const first = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const second = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const draft = yield* send(first);

          if (!(draft instanceof TransferDraft))
            throw new Error("Expected draft");

          yield* send(second);
          yield* send(first, approve(draft.request, key));

          const signed = Option.getOrThrow(
            yield* Transfers.use((service) => service.find(first.id)),
          );

          if (!(signed instanceof Authorized))
            throw new Error("Expected authorization");

          world.evidence.set(
            signed.sealed.hash,
            new Applied({ at: DateTime.nowUnsafe() }),
          );

          expect(yield* send(first)).toBeInstanceOf(Settled);

          const overview = yield* Wallet.use((wallet) =>
            wallet.overview(addressOf(key)),
          );

          if (!(overview instanceof Holding))
            throw new Error("Expected holding");

          expect(Option.getOrThrow(overview.latest).id).toBe(first.id);
          expect(Option.getOrThrow(overview.latest)).toBeInstanceOf(Settled);
        }),
    );

    it.effect(
      "a sequence change during signing redrafts before durable authorization",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          fundHolder(key);

          const order = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const draft = yield* send(order);

          if (!(draft instanceof TransferDraft))
            throw new Error("Expected draft");

          const advancing = Layer.effect(
            Chain,
            Effect.gen(function* () {
              const actual = yield* Chain;

              return Chain.of({
                ...actual,
                seal: (request, approval, holder) =>
                  actual
                    .seal(request, approval, holder)
                    .pipe(
                      Effect.tap(() =>
                        Effect.sync(() => fundHolder(key, "1001")),
                      ),
                    ),
              });
            }),
          ).pipe(Layer.provide(fakeChain));

          const advancingWallet = Wallet.serviceLayer.pipe(
            Layer.provide(stores),
            Layer.provide(advancing),
            Layer.provide(settings),
          );

          const result = yield* Wallet.use((wallet) =>
            wallet.transfer(order, approve(draft.request, key)),
          ).pipe(Effect.provide(Layer.fresh(advancingWallet)));

          if (!(result instanceof TransferDraft))
            throw new Error("Expected redraft");

          expect(paymentSequence(result)).toBe("1002");
          expect(
            Option.getOrThrow(
              yield* Transfers.use((service) => service.find(order.id)),
            ),
          ).toBeInstanceOf(Proposed);
          expect(
            yield* Transfers.use((service) => service.inFlight),
          ).toHaveLength(0);
        }),
    );

    it.effect(
      "a stale redraft cannot replace a concurrent durable authorization",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          fundHolder(key);

          const order = orderFor(
            key,
            AddressRecipient.make({ value: addressOf(key) }),
          );

          const draft = yield* send(order);

          const proposed = Option.getOrThrow(
            yield* Transfers.use((service) => service.find(order.id)),
          );

          if (
            !(draft instanceof TransferDraft) ||
            !(proposed instanceof Proposed)
          )
            throw new Error("Expected draft");

          yield* send(order, approve(draft.request, key));
          fundHolder(key, "1001");

          const replacement = yield* Chain.use((chain) =>
            chain.draftPayment(
              order.from,
              addressOf(key),
              order.asset,
              order.amount,
            ),
          ).pipe(Effect.provide(fakeChain));

          const saved = yield* Transfers.use((service) =>
            service.redraft(proposed, replacement),
          );

          if (!(saved instanceof Authorized))
            throw new Error("Expected frozen authorization");

          const outer = TransactionBuilder.fromXDR(
            saved.sealed.envelope,
            networkPassphrase,
          );

          if (!(outer instanceof FeeBumpTransaction))
            throw new Error("Expected fee bump");

          expect(outer.innerTransaction.sequence).toBe("1001");
        }),
    );
  },
);
