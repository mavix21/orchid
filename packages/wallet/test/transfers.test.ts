import { expect, test } from "bun:test";
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
  TransferDraft,
  Amount,
  Username,
  UsernameRecipient,
} from "../src/contract";
import { Applied } from "../src/server/Chain.server";
import { Directory, StoreFailure } from "../src/server/Directory.server";
import {
  Authorized,
  Concluded,
  Proposed,
  Transfers,
} from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import {
  dbLayer,
  world,
  fakeChain,
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

test("a signed transfer survives failed submit and sweep finishes without the device", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  world.accounts.set(addressOf(key), {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("50000000")),
  });

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  expect(draft.recipient).toBeInstanceOf(Profile);
  expect(await send(order)).toEqual(draft);
  world.failSubmit = true;
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(
    Pending,
  );

  const stored = Option.getOrThrow(
    await runStores(Transfers.use((transfers) => transfers.find(order.id))),
  );

  if (!(stored instanceof Authorized))
    throw new Error("Expected durable authorization");

  world.failSubmit = false;
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted.at(-1)?.hash).toBe(stored.sealed.hash);
  world.evidence.set(
    stored.sealed.hash,
    new Applied({ at: DateTime.nowUnsafe() }),
  );
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(await send(order)).toBeInstanceOf(Settled);
  expect(
    Option.getOrThrow(
      await runStores(Transfers.use((transfers) => transfers.find(order.id))),
    ),
  ).toBeInstanceOf(Concluded);
});

test("concurrent approvals allow only one signed transfer per sender", async () => {
  const key = Keypair.random();

  await create(key, "maria");
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
  const drafts = await Promise.all(orders.map((order) => send(order)));

  const results = await Promise.all(
    orders.map((order, index) => {
      const draft = drafts[index];

      if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

      return send(order, approve(draft.request, key));
    }),
  );

  expect(results.filter((result) => result instanceof Pending)).toHaveLength(1);
  expect(results.filter((result) => result instanceof SenderBusy)).toHaveLength(
    1,
  );
  expect(
    await runStores(Transfers.use((transfers) => transfers.inFlight)),
  ).toHaveLength(1);
});

test("same id concurrent approvals keep one immutable sealed envelope", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  world.accounts.set(addressOf(key), {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("50000000")),
  });

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  const results = await Promise.all([
    send(order, approve(draft.request, key)),
    send(order, approve(draft.request, key)),
  ]);

  expect(results.every((result) => result instanceof Pending)).toBe(true);
  expect(
    await runStores(Transfers.use((transfers) => transfers.inFlight)),
  ).toHaveLength(1);
});

test("database failure during authorization submits nothing", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  world.accounts.set(addressOf(key), {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("50000000")),
  });

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  const initial = world.submitted.length;

  const brokenTransfers = Layer.effect(
    Transfers,
    Effect.gen(function* () {
      const actual = yield* Transfers;

      return Transfers.of({
        ...actual,
        authorize: () =>
          Effect.fail(
            new StoreFailure({ cause: new Error("Database unavailable") }),
          ),
      });
    }),
  ).pipe(Layer.provide(Transfers.layer));

  const brokenWallet = Wallet.serviceLayer.pipe(
    Layer.provide(Layer.merge(Directory.layer, brokenTransfers)),
    Layer.provide(fakeChain),
    Layer.provide(dbLayer),
  );

  const result = await Effect.runPromise(
    Wallet.use((wallet) =>
      wallet.transfer(order, approve(draft.request, key)),
    ).pipe(Effect.result, Effect.provide(brokenWallet)),
  );

  expect(Result.isFailure(result)).toBe(true);
  expect(world.submitted).toHaveLength(initial);
  expect(
    Option.getOrThrow(
      await runStores(Transfers.use((service) => service.find(order.id))),
    ),
  ).toBeInstanceOf(Proposed);
});

test("username payments still pin the Orchid recipient and settle normally", async () => {
  const key = Keypair.random();
  const recipient = Keypair.random();

  await create(key, "maria");
  await create(recipient, "rosa");
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
    UsernameRecipient.make({ value: Schema.decodeSync(Username)("rosa") }),
  );

  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  expect(draft.recipient.address).toBe(addressOf(recipient));
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(
    Pending,
  );

  const stored = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(order.id))),
  );

  if (!(stored instanceof Authorized))
    throw new Error("Expected authorization");

  world.evidence.set(
    stored.sealed.hash,
    new Applied({ at: DateTime.nowUnsafe() }),
  );
  expect(await send(order)).toBeInstanceOf(Settled);
});
