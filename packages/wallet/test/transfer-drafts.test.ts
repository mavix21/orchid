import { expect, test } from "bun:test";
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
  PositiveUsdc,
  Settled,
  TransferDraft,
  TransferOrder,
  Usdc,
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
  walletLayer,
  run,
  runStores,
  addressOf,
  approve,
  create,
  orderFor,
  send,
  fundHolder,
  paymentSequence,
  useDisposableDatabase,
} from "./wallet-harness";

useDisposableDatabase();

test("near-expiry unsigned drafts refresh, while authorized bytes never change", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  world.accounts.set(addressOf(key), {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Usdc)("50000000")),
  });

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));

  await send(order);
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(
        sql`update transfers set "expiresAt" = now() + interval '10 seconds' where id = ${order.id}`,
      );
    }).pipe(Effect.provide(dbLayer)),
  );

  const refreshed = await send(order);

  if (!(refreshed instanceof TransferDraft))
    throw new Error("Expected refreshed draft");

  expect(DateTime.toEpochMillis(refreshed.request.expiresAt)).toBeGreaterThan(
    Date.now() + 20000,
  );
  await send(order, approve(refreshed.request, key));

  const authorized = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(order.id))),
  );

  if (!(authorized instanceof Authorized))
    throw new Error("Expected authorization");

  const competing = await runStores(
    Transfers.use((service) =>
      service.propose(
        order,
        new ExternalRecipient({ address: addressOf(Keypair.random()) }),
        refreshed.request,
      ),
    ),
  );

  expect(competing).toEqual(authorized);

  const changed = new TransferOrder({
    ...order,
    amount: Schema.decodeSync(PositiveUsdc)("20000000"),
  });

  const refused = await Effect.runPromise(
    Wallet.use((wallet) => wallet.transfer(changed, Option.none())).pipe(
      Effect.result,
      Effect.provide(walletLayer),
    ),
  );

  expect(Result.isFailure(refused)).toBe(true);
  expect(
    Option.getOrThrow(
      await runStores(Transfers.use((service) => service.find(order.id))),
    ),
  ).toEqual(authorized);
});

test("double tap redrafts a still-live stale sequence before accepting its approval", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const orders = [
    orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
    orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
  ];

  const first = orders[0];
  const second = orders[1];

  if (!first || !second) throw new Error("Expected two orders");

  const firstDraft = await send(first);
  const secondDraft = await send(second);

  if (
    !(firstDraft instanceof TransferDraft) ||
    !(secondDraft instanceof TransferDraft)
  )
    throw new Error("Expected drafts");

  expect(paymentSequence(firstDraft)).toBe("1001");
  expect(paymentSequence(secondDraft)).toBe("1001");
  await send(first, approve(firstDraft.request, key));

  const signed = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(first.id))),
  );

  if (!(signed instanceof Authorized))
    throw new Error("Expected authorization");

  fundHolder(key, "1001");
  world.evidence.set(
    signed.sealed.hash,
    new Applied({ at: DateTime.nowUnsafe() }),
  );
  expect(await send(first)).toBeInstanceOf(Settled);

  const redrafted = await send(second, approve(secondDraft.request, key));

  if (!(redrafted instanceof TransferDraft))
    throw new Error("Expected redraft");

  expect(paymentSequence(redrafted)).toBe("1002");
  expect(
    Option.getOrThrow(
      await runStores(Transfers.use((service) => service.find(second.id))),
    ),
  ).toBeInstanceOf(Proposed);
  expect(await send(second, approve(redrafted.request, key))).toBeInstanceOf(
    Pending,
  );
});

test("SlotTaken reconciliation refreshes the waiting draft after the holder consumes its sequence", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const first = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));

  const second = orderFor(
    key,
    AddressRecipient.make({ value: addressOf(key) }),
  );

  const firstDraft = await send(first);
  const secondDraft = await send(second);

  if (
    !(firstDraft instanceof TransferDraft) ||
    !(secondDraft instanceof TransferDraft)
  )
    throw new Error("Expected drafts");

  await send(first, approve(firstDraft.request, key));

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
    Layer.provide(Layer.merge(Directory.layer, finishing)),
    Layer.provide(fakeChain),
    Layer.provide(dbLayer),
  );

  const result = await Effect.runPromise(
    Wallet.use((wallet) =>
      wallet.transfer(second, approve(secondDraft.request, key)),
    ).pipe(Effect.provide(finishingWallet)),
  );

  if (!(result instanceof TransferDraft)) throw new Error("Expected redraft");

  expect(paymentSequence(result)).toBe("1002");
  expect(await send(second, approve(result.request, key))).toBeInstanceOf(
    Pending,
  );
});

test("a proven consumed authorization concludes and releases the sender slot", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  await send(order, approve(draft.request, key));

  const signed = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(order.id))),
  );

  if (!(signed instanceof Authorized))
    throw new Error("Expected authorization");

  fundHolder(key, "1001");
  world.evidence.set(
    signed.sealed.hash,
    new Rejected({ code: "sequence_consumed" }),
  );
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(await send(order)).toBeInstanceOf(Failed);
  expect(
    await runStores(Transfers.use((service) => service.inFlight)),
  ).toHaveLength(0);

  const next = await send(
    orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
  );

  if (!(next instanceof TransferDraft)) throw new Error("Expected next draft");

  expect(paymentSequence(next)).toBe("1002");
});

test("an unsigned newer draft cannot hide the latest authorized or settled receipt", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const first = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));

  const second = orderFor(
    key,
    AddressRecipient.make({ value: addressOf(key) }),
  );

  const draft = await send(first);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  await send(second);
  await send(first, approve(draft.request, key));

  const signed = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(first.id))),
  );

  if (!(signed instanceof Authorized))
    throw new Error("Expected authorization");

  world.evidence.set(
    signed.sealed.hash,
    new Applied({ at: DateTime.nowUnsafe() }),
  );

  expect(await send(first)).toBeInstanceOf(Settled);

  const overview = await run(
    Wallet.use((wallet) => wallet.overview(addressOf(key))),
  );

  if (!(overview instanceof Holding)) throw new Error("Expected holding");

  expect(Option.getOrThrow(overview.latest).id).toBe(first.id);
  expect(Option.getOrThrow(overview.latest)).toBeInstanceOf(Settled);
});

test("a sequence change during signing redrafts before durable authorization", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  const advancing = Layer.effect(
    Chain,
    Effect.gen(function* () {
      const actual = yield* Chain;

      return Chain.of({
        ...actual,
        seal: (request, approval, holder) =>
          actual
            .seal(request, approval, holder)
            .pipe(Effect.tap(() => Effect.sync(() => fundHolder(key, "1001")))),
      });
    }),
  ).pipe(Layer.provide(fakeChain));

  const advancingWallet = Wallet.serviceLayer.pipe(
    Layer.provide(stores),
    Layer.provide(advancing),
  );

  const result = await Effect.runPromise(
    Wallet.use((wallet) =>
      wallet.transfer(order, approve(draft.request, key)),
    ).pipe(Effect.provide(advancingWallet)),
  );

  if (!(result instanceof TransferDraft)) throw new Error("Expected redraft");

  expect(paymentSequence(result)).toBe("1002");
  expect(
    Option.getOrThrow(
      await runStores(Transfers.use((service) => service.find(order.id))),
    ),
  ).toBeInstanceOf(Proposed);
  expect(
    await runStores(Transfers.use((service) => service.inFlight)),
  ).toHaveLength(0);
});

test("a stale redraft cannot replace a concurrent durable authorization", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const draft = await send(order);

  const proposed = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(order.id))),
  );

  if (!(draft instanceof TransferDraft) || !(proposed instanceof Proposed))
    throw new Error("Expected draft");

  await send(order, approve(draft.request, key));
  fundHolder(key, "1001");

  const replacement = await Effect.runPromise(
    Chain.use((chain) =>
      chain.draftPayment(order.from, addressOf(key), order.amount),
    ).pipe(Effect.provide(fakeChain)),
  );

  const saved = await runStores(
    Transfers.use((service) => service.redraft(proposed, replacement)),
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
});
