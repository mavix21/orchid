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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AddressRecipient,
  ExternalRecipient,
  ExternalMemoRequired,
  MemoNotAllowed,
  PaymentMemo,
  Pending,
  Settled,
  TransferDraft,
  TransferOrder,
} from "../src/contract";
import { Applied } from "../src/server/Chain.server";
import {
  Authorized,
  Proposed,
  Transfers,
} from "../src/server/Transfers.server";
import { PaymentFacts, readEnvelope } from "../src/stellar/envelopes";
import { networkPassphrase } from "../src/stellar/network";
import {
  dbLayer,
  world,
  runStores,
  addressOf,
  registerExchange,
  approve,
  create,
  orderFor,
  send,
  fundHolder,
  useDisposableDatabase,
} from "./wallet-harness";

useDisposableDatabase();

test("unlisted external destinations accept no memo and expose that a memo is optional", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const destinationKey = Keypair.random();
  fundHolder(destinationKey);
  const destination = addressOf(destinationKey);
  const order = orderFor(key, AddressRecipient.make({ value: destination }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft))
    throw new Error("Expected external draft");

  expect(draft.recipient).toEqual(
    new ExternalRecipient({ address: destination }),
  );
  expect(draft.memoRequired).toBe(false);
  const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

  if (!(facts instanceof PaymentFacts))
    throw new Error("Expected payment facts");

  expect(facts.memo).toBeUndefined();
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(
    Pending,
  );

  const signed = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(order.id))),
  );

  if (!(signed instanceof Authorized))
    throw new Error("Expected authorization");

  expect(signed.order.memo).toBeUndefined();

  const outer = TransactionBuilder.fromXDR(
    signed.sealed.envelope,
    networkPassphrase,
  );

  if (!(outer instanceof FeeBumpTransaction))
    throw new Error("Expected fee bump");

  expect(outer.innerTransaction.memo.type).toBe("none");
  world.evidence.set(
    signed.sealed.hash,
    new Applied({ at: DateTime.nowUnsafe() }),
  );
  const receipt = await send(order);

  if (!(receipt instanceof Settled))
    throw new Error("Expected settled receipt");

  expect(receipt.memo).toBeUndefined();
});

test("known exchange destinations refuse missing memos with client-visible source evidence", async () => {
  const key = Keypair.random();

  await create(key, "maria");

  const entry = registerExchange(addressOf(Keypair.random()));
  const order = orderFor(key, AddressRecipient.make({ value: entry.address }));
  const initialSubmissions = world.submitted.length;

  expect(await send(order)).toEqual(
    new ExternalMemoRequired({
      address: entry.address,
      exchange: entry.exchange,
      source: entry.source,
    }),
  );
  expect(
    Option.isNone(
      await runStores(Transfers.use((service) => service.find(order.id))),
    ),
  ).toBe(true);
  expect(world.submitted).toHaveLength(initialSubmissions);
});

test("a new registry entry blocks an unsigned draft but preserves an authorized external transfer", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const destinationKey = Keypair.random();
  fundHolder(destinationKey);
  const destination = addressOf(destinationKey);
  const order = orderFor(key, AddressRecipient.make({ value: destination }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  registerExchange(destination);
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(
    ExternalMemoRequired,
  );
  expect(
    Option.getOrThrow(
      await runStores(Transfers.use((service) => service.find(order.id))),
    ),
  ).toBeInstanceOf(Proposed);
  world.exchangeMemos.length = 0;
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(
    Pending,
  );
  registerExchange(destination);
  expect(await send(order)).toBeInstanceOf(Pending);
});

test("external text/id memos survive draft, signature, durable order and receipt; Orchid memos are refused", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const memos: ReadonlyArray<PaymentMemo> = [
    { type: "text", value: "deposit-123" },
    { type: "id", value: "18446744073709551615" },
  ];

  for (const required of [false, true]) {
    for (const memo of memos) {
      const destinationKey = Keypair.random();
      fundHolder(destinationKey);
      const destination = addressOf(destinationKey);

      if (required) registerExchange(destination);

      const order = new TransferOrder({
        ...orderFor(key, AddressRecipient.make({ value: destination })),
        memo: Schema.decodeUnknownSync(PaymentMemo)(memo),
      });

      const draft = await send(order);

      if (!(draft instanceof TransferDraft))
        throw new Error("Expected memo draft");

      expect(draft.recipient).toBeInstanceOf(ExternalRecipient);
      expect(draft.memoRequired).toBe(required);
      const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

      if (!(facts instanceof PaymentFacts))
        throw new Error("Expected payment facts");

      expect(facts.memo).toEqual(memo);
      await send(order, approve(draft.request, key));

      const signed = Option.getOrThrow(
        await runStores(Transfers.use((service) => service.find(order.id))),
      );

      if (!(signed instanceof Authorized))
        throw new Error("Expected authorization");

      expect(signed.order.memo).toEqual(memo);
      world.evidence.set(
        signed.sealed.hash,
        new Applied({ at: DateTime.nowUnsafe() }),
      );

      const receipt = await send(order);

      if (!(receipt instanceof Settled)) throw new Error("Expected receipt");

      expect(receipt.memo).toEqual(memo);
      expect(receipt.recipient).toEqual(
        new ExternalRecipient({ address: destination }),
      );

      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase();

          return yield* db.execute(
            sql`select recipient from transfers where id = ${order.id}`,
          );
        }).pipe(Effect.provide(dbLayer)),
      );

      expect(rows.rows[0]?.recipient).toBeNull();
    }
  }

  registerExchange(addressOf(key));

  const plain = await send(
    orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
  );

  if (!(plain instanceof TransferDraft))
    throw new Error("Expected Orchid draft");

  expect(plain.memoRequired).toBe(false);

  const orchid = new TransferOrder({
    ...orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
    memo: Schema.decodeSync(PaymentMemo)({ type: "text", value: "unwanted" }),
  });

  expect(await send(orchid)).toBeInstanceOf(MemoNotAllowed);
  expect(
    Option.isNone(
      await runStores(Transfers.use((service) => service.find(orchid.id))),
    ),
  ).toBe(true);
});
