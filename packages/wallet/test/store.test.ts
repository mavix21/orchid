import { beforeAll, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Account,
  Transaction,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { databaseLayer, makeDatabase } from "@workspace/db";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressBound,
  AddressRecipient,
  PhoneRecipient,
  Approval,
  ExternalRecipient,
  ExternalMemoRequired,
  InvalidAddress,
  MemoNotAllowed,
  PaymentMemo,
  Failed,
  NotSponsored,
  Holding,
  NeedsReopening,
  Opened,
  OpeningDraft,
  OpeningPending,
  Pending,
  PhoneNotSupported,
  PositiveUsdc,
  Profile,
  Recipient,
  RecoveryDraft,
  SenderBusy,
  Settled,
  SigningRequest,
  TransferDraft,
  TransferId,
  TransferOrder,
  Usdc,
  Username,
  UsernameRecipient,
  UsernameTaken,
  UnknownRecipient,
  WalletClaim,
} from "../src/contract";
import {
  type AccountState,
  Applied,
  Chain,
  ChainUnreachable,
  Sealed,
  Rejected,
  type Settlement,
  Undecided,
} from "../src/server/Chain.server";
import { KnownExchangeMemo, exchangeMemoFor } from "../src/server/exchange-memos.server";
import { Directory, StoreFailure } from "../src/server/Directory.server";
import { usernames, wallets } from "../src/server/tables.server";
import {
  Authorized,
  Concluded,
  Proposed,
  SlotTaken,
  Transfers,
} from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { WalletSettings } from "../src/server/settings.server";
import {
  PaymentFacts,
  readEnvelope,
  draftOpening,
  draftPayment,
  draftRecovery,
  signingPayload,
} from "../src/stellar/envelopes";
import { network, networkPassphrase, sweepBatchSize } from "../src/stellar/network";

// This suite has one fixed, disposable local database and never reads a deployment URL.
const dbLayer = databaseLayer({
  connectionString: "postgres://orchid:orchid-local@127.0.0.1:55433/wallet_test",
});

const stores = Layer.mergeAll(Directory.layer, Transfers.layer).pipe(Layer.provide(dbLayer));
const sponsor = Keypair.random();
const feePayer = Keypair.random();
const reserveSponsor = Schema.decodeSync(AccountAddress)(sponsor.publicKey());

const settings = Layer.succeed(WalletSettings, {
  rpcUrl: "https://soroban-testnet.stellar.org",
  reserveSponsorSecret: Redacted.make(sponsor.secret()),
  feePayerSecret: Redacted.make(feePayer.secret()),
});

const realChain = Chain.layer.pipe(Layer.provide(settings));

const world = {
  accounts: new Map<AccountAddress, AccountState>(),
  evidence: new Map<string, Settlement>(),
  submitted: new Array<Sealed>(),
  exchangeMemos: new Array<KnownExchangeMemo>(),
  failSubmit: false,
};

const fakeChain = Layer.effect(
  Chain,
  Effect.gen(function* () {
    const real = yield* Chain;

    const account = (address: AccountAddress) =>
      Effect.succeed(Option.fromNullishOr(world.accounts.get(address)));

    const request = (envelope: SigningRequest["envelope"], maxTime: number) =>
      new SigningRequest({ envelope, expiresAt: DateTime.makeUnsafe(maxTime * 1000) });

    return Chain.of({
      ...real,
      memoRequiredFor: (address) => exchangeMemoFor(address, world.exchangeMemos),
      account,
      pastOpeningWindow: (sealed) =>
        Effect.succeed(DateTime.toEpochMillis(sealed.expiresAt) < Date.now()),
      balance: (address) =>
        account(address).pipe(Effect.map(Option.flatMap((state) => state.balance))),
      draftOpening: (address) =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);

          return request(
            draftOpening({
              source: new Account(reserveSponsor, "100"),
              address,
              createAccount: !world.accounts.has(address),
              minTime: now,
              maxTime: now + 120,
            }),
            now + 120,
          );
        }),
      draftPayment: (from, to, amount, memo) =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);

          return request(
            draftPayment({
              source: new Account(from, world.accounts.get(from)?.sequence ?? "100"),
              to,
              amount,
              memo,
              minTime: now,
              maxTime: now + 120,
            }),
            now + 120,
          );
        }),
      draftRecovery: (address) =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);

          return request(
            draftRecovery({
              source: new Account(address, world.accounts.get(address)?.sequence ?? "100"),
              reserveSponsor,
              minTime: now + 60,
              maxTime: now + 180,
            }),
            now + 180,
          );
        }),
      submit: (sealed) =>
        Effect.gen(function* () {
          if (world.failSubmit)
            return yield* new ChainUnreachable({ cause: new Error("Network dropped") });

          world.submitted.push(sealed);

          const outer = TransactionBuilder.fromXDR(sealed.envelope, networkPassphrase);
          const inner = outer instanceof FeeBumpTransaction ? outer.innerTransaction : outer;
          const first = inner.operations[0];

          if (first?.type === "beginSponsoringFutureReserves") {
            const address = Schema.decodeSync(AccountAddress)(first.sponsoredId);

            world.accounts.set(address, {
              sequence: world.accounts.get(address)?.sequence ?? "1000",
              ledger: 100,
              accountSponsored: true,
              sponsored: true,
              nativeBalance: 0n,
              balance: Option.some(Schema.decodeSync(Usdc)("0")),
            });
          }
        }),
      settlement: (sealed) => Effect.succeed(world.evidence.get(sealed.hash) ?? new Undecided()),
    });
  }),
).pipe(Layer.provide(realChain));

const walletLayer = Wallet.serviceLayer.pipe(Layer.provide(stores), Layer.provide(fakeChain));

const run = <A, E>(program: Effect.Effect<A, E, Wallet>) =>
  Effect.runPromise(program.pipe(Effect.provide(walletLayer)));

const runStores = <A, E>(program: Effect.Effect<A, E, Directory | Transfers>) =>
  Effect.runPromise(program.pipe(Effect.provide(stores)));

const addressOf = (key: Keypair) => Schema.decodeSync(AccountAddress)(key.publicKey());

// Synthetic test fixture only; never added to the shipped registry.
const registerExchange = (address: AccountAddress) => {
  const entry = new KnownExchangeMemo({
    network,
    address,
    exchange: "Synthetic exchange fixture",
    source: "https://example.com/fixtures/stellar-testnet-memo-required",
  });

  world.exchangeMemos.push(entry);

  return entry;
};

const approve = (request: SigningRequest, key: Keypair) =>
  Option.some(new Approval({ signature: key.sign(signingPayload(request.envelope)) }));

const claimFor = (key: Keypair, name: string) =>
  new WalletClaim({ address: addressOf(key), username: Schema.decodeSync(Username)(name) });

const opening = (claim: WalletClaim, approval: Option.Option<Approval> = Option.none()) =>
  run(Wallet.use((wallet) => wallet.open(claim, approval)));

const create = async (key: Keypair, name: string) => {
  const claim = claimFor(key, name);
  const draft = await opening(claim);

  if (!(draft instanceof OpeningDraft)) throw new Error("Expected opening draft");

  expect(await opening(claim, approve(draft.request, key))).toBeInstanceOf(OpeningPending);

  const recovery = await opening(claim);

  if (!(recovery instanceof RecoveryDraft)) throw new Error("Expected recovery draft");

  expect(await opening(claim, approve(recovery.request, key))).toBeInstanceOf(Opened);

  return claim;
};

const orderFor = (sender: Keypair, to: Recipient) =>
  new TransferOrder({
    id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
    from: addressOf(sender),
    to,
    amount: Schema.decodeSync(PositiveUsdc)("10000000"),
  });

const send = (order: TransferOrder, approval: Option.Option<Approval> = Option.none()) =>
  run(Wallet.use((wallet) => wallet.transfer(order, approval)));

beforeAll(async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
      yield* migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
    }).pipe(Effect.provide(dbLayer)),
  );
});

beforeEach(async () => {
  world.accounts.clear();
  world.evidence.clear();
  world.submitted.length = 0;
  world.exchangeMemos.length = 0;
  world.failSubmit = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(sql`truncate transfers, usernames, wallets`);
    }).pipe(Effect.provide(dbLayer)),
  );
});

test("opening resumes missing recovery and never activates without a valid signature", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");
  const draft = await opening(claim);

  if (!(draft instanceof OpeningDraft)) throw new Error("Expected draft");

  await opening(claim, approve(draft.request, key));

  const recovery = await opening(claim);
  const repeated = await opening(claim);

  expect(repeated).toEqual(recovery);
  expect(recovery).toBeInstanceOf(RecoveryDraft);
  expect(
    (await runStores(Directory.use((directory) => directory.byAddress(claim.address)))).pipe(
      Option.map((row) => row.status),
    ),
  ).toEqual(Option.some("opening"));

  if (!(recovery instanceof RecoveryDraft)) throw new Error("Expected recovery");

  expect(await opening(claim, approve(recovery.request, Keypair.random()))).toEqual(recovery);
  expect(await opening(claim, approve(recovery.request, key))).toBeInstanceOf(Opened);
  expect(world.submitted).toHaveLength(1);
});

test("missing account and missing trustline reopen with the same username and key", async () => {
  const key = Keypair.random();
  const claim = await create(key, "maria");

  for (const missing of ["account", "trustline"]) {
    if (missing === "account") world.accounts.delete(claim.address);
    else
      world.accounts.set(claim.address, {
        sequence: "2000",
        ledger: 100,
        accountSponsored: true,
        sponsored: true,
        nativeBalance: 0n,
        balance: Option.none(),
      });

    expect(await run(Wallet.use((wallet) => wallet.overview(claim.address)))).toBeInstanceOf(
      NeedsReopening,
    );
    expect(
      (await runStores(Directory.use((directory) => directory.byAddress(claim.address)))).pipe(
        Option.map((row) => row.status),
      ),
    ).toEqual(Option.some("recovered"));
    await create(key, "maria");
    expect(await run(Wallet.use((wallet) => wallet.overview(claim.address)))).toBeInstanceOf(
      Holding,
    );
  }
});

test("a signed transfer survives failed submit and sweep finishes without the device", async () => {
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
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  expect(draft.recipient).toBeInstanceOf(Profile);
  expect(await send(order)).toEqual(draft);
  world.failSubmit = true;
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(Pending);

  const stored = Option.getOrThrow(
    await runStores(Transfers.use((transfers) => transfers.find(order.id))),
  );

  if (!(stored instanceof Authorized)) throw new Error("Expected durable authorization");

  world.failSubmit = false;
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted.at(-1)?.hash).toBe(stored.sealed.hash);
  world.evidence.set(stored.sealed.hash, new Applied({ at: DateTime.nowUnsafe() }));
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(await send(order)).toBeInstanceOf(Settled);
  expect(
    Option.getOrThrow(await runStores(Transfers.use((transfers) => transfers.find(order.id)))),
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
    balance: Option.some(Schema.decodeSync(Usdc)("50000000")),
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
  expect(results.filter((result) => result instanceof SenderBusy)).toHaveLength(1);
  expect(await runStores(Transfers.use((transfers) => transfers.inFlight))).toHaveLength(1);
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
    balance: Option.some(Schema.decodeSync(Usdc)("50000000")),
  });

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  const results = await Promise.all([
    send(order, approve(draft.request, key)),
    send(order, approve(draft.request, key)),
  ]);

  expect(results.every((result) => result instanceof Pending)).toBe(true);
  expect(await runStores(Transfers.use((transfers) => transfers.inFlight))).toHaveLength(1);
});

test("phone support is a typed refusal and bound names cannot be taken by another key", async () => {
  const key = Keypair.random();

  expect(await send(orderFor(key, PhoneRecipient.make({ value: "+51999999999" })))).toBeInstanceOf(
    PhoneNotSupported,
  );
  await create(key, "maria");

  const before = world.submitted.length;

  expect(await opening(claimFor(Keypair.random(), "maria"))).toEqual(
    new UsernameTaken({ username: Schema.decodeSync(Username)("maria") }),
  );
  expect(world.submitted).toHaveLength(before);
});

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
    balance: Option.some(Schema.decodeSync(Usdc)("1")),
  });
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted).toHaveLength(initial);
  world.accounts.set(claim.address, {
    sequence: "1001",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Usdc)("0")),
  });
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted).toHaveLength(initial);
  world.accounts.set(claim.address, {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 1n,
    balance: Option.some(Schema.decodeSync(Usdc)("0")),
  });
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted).toHaveLength(initial);
  world.accounts.set(claim.address, {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Usdc)("0")),
  });
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(world.submitted).toHaveLength(initial + 1);

  const submitted = world.submitted.at(-1);

  if (!submitted) throw new Error("Expected recovery submission");

  world.evidence.set(submitted.hash, new Applied({ at: DateTime.nowUnsafe() }));
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(
    (await runStores(Directory.use((directory) => directory.byAddress(claim.address)))).pipe(
      Option.map((row) => row.status),
    ),
  ).toEqual(Option.some("recovered"));
});

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

  if (!(refreshed instanceof TransferDraft)) throw new Error("Expected refreshed draft");

  expect(DateTime.toEpochMillis(refreshed.request.expiresAt)).toBeGreaterThan(Date.now() + 20000);
  await send(order, approve(refreshed.request, key));

  const authorized = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(order.id))),
  );

  if (!(authorized instanceof Authorized)) throw new Error("Expected authorization");

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
    Option.getOrThrow(await runStores(Transfers.use((service) => service.find(order.id)))),
  ).toEqual(authorized);
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
    balance: Option.some(Schema.decodeSync(Usdc)("50000000")),
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
          Effect.fail(new StoreFailure({ cause: new Error("Database unavailable") })),
      });
    }),
  ).pipe(Layer.provide(Transfers.layer));

  const brokenWallet = Wallet.serviceLayer.pipe(
    Layer.provide(Layer.merge(Directory.layer, brokenTransfers)),
    Layer.provide(fakeChain),
    Layer.provide(dbLayer),
  );

  const result = await Effect.runPromise(
    Wallet.use((wallet) => wallet.transfer(order, approve(draft.request, key))).pipe(
      Effect.result,
      Effect.provide(brokenWallet),
    ),
  );

  expect(Result.isFailure(result)).toBe(true);
  expect(world.submitted).toHaveLength(initial);
  expect(
    Option.getOrThrow(await runStores(Transfers.use((service) => service.find(order.id)))),
  ).toBeInstanceOf(Proposed);
});

test("a name is bound only by the signed opening; drafts reserve nothing", async () => {
  const key = Keypair.random();
  const first = claimFor(key, "maria");
  const draft = await opening(first);

  if (!(draft instanceof OpeningDraft)) throw new Error("Expected draft");

  // Asking for another name before signing is not a conflict with the abandoned first choice.
  const second = claimFor(key, "maria2");
  const redraft = await opening(second);

  if (!(redraft instanceof OpeningDraft)) throw new Error("Expected draft for the new name");

  expect(await opening(claimFor(Keypair.random(), "maria"))).toBeInstanceOf(OpeningDraft);
  expect(await opening(second, approve(redraft.request, key))).toBeInstanceOf(OpeningPending);
  expect(await opening(first)).toEqual(new AddressBound({ profile: new Profile(second) }));
  expect(await opening(claimFor(Keypair.random(), "maria2"))).toEqual(
    new UsernameTaken({ username: second.username }),
  );
});

test("concurrent signed openings bind a name once and the loser submits nothing", async () => {
  const keys = [Keypair.random(), Keypair.random()];
  const claims = keys.map((key) => claimFor(key, "maria"));
  const drafts = await Promise.all(claims.map((claim) => opening(claim)));

  const results = await Promise.all(
    drafts.map((draft, index) => {
      if (!(draft instanceof OpeningDraft)) throw new Error("Expected draft");

      return opening(claims[index] ?? claims[0], approve(draft.request, keys[index] ?? keys[0]));
    }),
  );

  expect(results.filter((result) => result instanceof OpeningPending)).toHaveLength(1);
  expect(results.filter((result) => result instanceof UsernameTaken)).toHaveLength(1);
  expect(world.submitted).toHaveLength(1);

  const loser = results.findIndex((result) => result instanceof UsernameTaken);
  const key = keys[loser] ?? keys[0];
  const renamed = claimFor(key, "maria_2");
  const retry = await opening(renamed);

  if (!(retry instanceof OpeningDraft)) throw new Error("Expected loser to redraft");

  expect(await opening(renamed, approve(retry.request, key))).toBeInstanceOf(OpeningPending);
  expect(world.submitted).toHaveLength(2);
});

// Store-level fixtures; these bytes are never submitted.
const placeholderRequest = () =>
  new SigningRequest({
    envelope: Schema.decodeSync(SigningRequest.fields.envelope)("AAAA"),
    expiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
  });

const placeholderSealed = () =>
  new Sealed({
    envelope: "AAAA",
    hash: "00".repeat(32),
    expiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
  });

test("the binding write refuses a taken name even when the soft check is skipped", async () => {
  await create(Keypair.random(), "maria");

  const key = Keypair.random();
  const claim = claimFor(key, "maria");
  const row = await runStores(Directory.use((directory) => directory.start(claim.address)));

  const draft = await runStores(
    Directory.use((directory) => directory.draft(row, placeholderRequest())),
  );

  const sealed = placeholderSealed();

  expect(
    await runStores(Directory.use((directory) => directory.seal(draft, sealed, claim))),
  ).toEqual(new UsernameTaken({ username: claim.username }));

  const stored = Option.getOrThrow(
    await runStores(Directory.use((directory) => directory.byAddress(claim.address))),
  );

  expect(stored.attemptHash).toBeNull();
  expect(stored.version).toBe(draft.version);
});

test("a stale binding write stores neither the attempt nor the name", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");
  const row = await runStores(Directory.use((directory) => directory.start(claim.address)));

  const sealed = placeholderSealed();

  await runStores(Directory.use((directory) => directory.draft(row, placeholderRequest())));

  const written = await runStores(Directory.use((directory) => directory.seal(row, sealed, claim)));

  if (written instanceof UsernameTaken || written instanceof AddressBound)
    throw new Error("Expected the current row back");

  expect(written.attemptHash).toBeNull();
  expect(await opening(claimFor(Keypair.random(), "maria"))).toBeInstanceOf(OpeningDraft);
});

test("reserved names are never bound", async () => {
  const key = Keypair.random();

  for (const name of ["orchid", "support", "admin", "security", "wallet", "official"]) {
    expect(await opening(claimFor(key, name))).toEqual(
      new UsernameTaken({ username: Schema.decodeSync(Username)(name) }),
    );
  }

  expect(
    Option.isNone(
      await runStores(Directory.use((directory) => directory.byAddress(addressOf(key)))),
    ),
  ).toBe(true);
  expect(world.submitted).toHaveLength(0);
});

test("a recovered name stays bound to its address but is not payable until reopened", async () => {
  const key = Keypair.random();
  const sender = Keypair.random();
  const claim = await create(key, "maria");

  await create(sender, "rosa");
  fundHolder(sender);
  world.accounts.delete(claim.address);
  expect(await run(Wallet.use((wallet) => wallet.overview(claim.address)))).toEqual(
    new NeedsReopening({ profile: new Profile(claim) }),
  );

  const order = orderFor(sender, UsernameRecipient.make({ value: claim.username }));

  expect(await send(order)).toBeInstanceOf(UnknownRecipient);
  expect(await opening(claimFor(Keypair.random(), "maria"))).toBeInstanceOf(UsernameTaken);
  expect(await opening(claimFor(key, "maria2"))).toEqual(
    new AddressBound({ profile: new Profile(claim) }),
  );

  const draft = await opening(claim);

  if (!(draft instanceof OpeningDraft)) throw new Error("Expected reopening draft");

  // Repair is in progress: the wallet stays recovered and unpayable until activation.
  await opening(claim, approve(draft.request, key));
  expect(await run(Wallet.use((wallet) => wallet.overview(claim.address)))).toBeInstanceOf(
    NeedsReopening,
  );
  expect(await send(order)).toBeInstanceOf(UnknownRecipient);

  const recovery = await opening(claim);

  if (!(recovery instanceof RecoveryDraft)) throw new Error("Expected recovery draft");

  expect(await opening(claim, approve(recovery.request, key))).toBeInstanceOf(Opened);
  expect(await send(order)).toBeInstanceOf(TransferDraft);
});

test("an existing account without a name binds it before activation", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");

  world.accounts.set(claim.address, {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Usdc)("0")),
  });

  const recovery = await opening(claim);

  if (!(recovery instanceof RecoveryDraft)) throw new Error("Expected recovery draft");

  expect(await opening(claim, approve(recovery.request, key))).toEqual(
    new Opened({ profile: new Profile(claim) }),
  );
  expect(await opening(claimFor(Keypair.random(), "maria"))).toBeInstanceOf(UsernameTaken);
  expect(world.submitted).toHaveLength(0);
});

test("a sealed opening outside RPC history redrafts after the ledger passes maxTime", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");
  const row = await runStores(Directory.use((directory) => directory.start(claim.address)));

  const now = Math.floor(Date.now() / 1000);

  const envelope = draftOpening({
    source: new Account(reserveSponsor, "100"),
    address: claim.address,
    createAccount: true,
    minTime: now - 200,
    maxTime: now - 80,
  });

  const inner = TransactionBuilder.fromXDR(envelope, networkPassphrase);

  if (!(inner instanceof Transaction)) throw new Error("Expected inner transaction");

  inner.sign(sponsor, key);

  const outer = TransactionBuilder.buildFeeBumpTransaction(
    feePayer.publicKey(),
    "100",
    inner,
    networkPassphrase,
  );

  outer.sign(feePayer);

  const historical = new Sealed({
    envelope: outer.toXDR(),
    hash: Array.from(outer.hash(), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    expiresAt: DateTime.makeUnsafe((now - 80) * 1000),
  });

  expect(
    await runStores(Directory.use((directory) => directory.seal(row, historical, claim))),
  ).not.toBeInstanceOf(UsernameTaken);

  const retry = await opening(claim);

  expect(retry).toBeInstanceOf(OpeningDraft);
  expect(world.submitted).toHaveLength(0);
  expect(
    Option.getOrThrow(
      await runStores(Directory.use((directory) => directory.byAddress(claim.address))),
    ).attemptHash,
  ).toBeNull();
});

test("one missing RPC observation does not demote an active wallet", async () => {
  const key = Keypair.random();
  const claim = await create(key, "maria");
  let reads = 0;

  const transient = Layer.effect(
    Chain,
    Effect.gen(function* () {
      const real = yield* Chain;

      return Chain.of({
        ...real,
        account: (address) => {
          reads++;

          return reads === 1 ? Effect.succeed(Option.none()) : real.account(address);
        },
      });
    }),
  ).pipe(Layer.provide(fakeChain));

  const transientWallet = Wallet.serviceLayer.pipe(Layer.provide(stores), Layer.provide(transient));

  const result = await Effect.runPromise(
    Wallet.use((wallet) => wallet.overview(claim.address)).pipe(Effect.provide(transientWallet)),
  );

  expect(result).toBeInstanceOf(Holding);
  expect(reads).toBe(2);
  expect(
    Option.getOrThrow(
      await runStores(Directory.use((directory) => directory.byAddress(claim.address))),
    ).status,
  ).toBe("active");
});

test("unsponsored and differently sponsored accounts never receive recovery drafts", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");

  world.accounts.set(claim.address, {
    sequence: "1000",
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Usdc)("0")),
    ledger: 100,
    accountSponsored: false,
    sponsored: false,
  });
  expect(await opening(claim)).toBeInstanceOf(NotSponsored);
  expect(
    Option.isNone(
      await runStores(Directory.use((directory) => directory.byAddress(claim.address))),
    ),
  ).toBe(true);
  world.accounts.set(claim.address, {
    sequence: "1000",
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Usdc)("0")),
    ledger: 100,
    accountSponsored: true,
    sponsored: false,
  });
  expect(await opening(claim)).toBeInstanceOf(NotSponsored);
  expect(world.submitted).toHaveLength(0);
});

test("bad address checksums are typed refusals before username claims or drafts", async () => {
  const key = Keypair.random();
  const valid = addressOf(key);

  const bad = Schema.decodeSync(AccountAddress)(
    `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`,
  );

  const claim = new WalletClaim({ username: Schema.decodeSync(Username)("maria"), address: bad });

  expect(await opening(claim)).toBeInstanceOf(InvalidAddress);
  expect(await run(Wallet.use((wallet) => wallet.overview(bad)))).toBeInstanceOf(InvalidAddress);
  expect(
    Option.isNone(await runStores(Directory.use((directory) => directory.byAddress(bad)))),
  ).toBe(true);
  expect(await send(orderFor(key, AddressRecipient.make({ value: bad })))).toBeInstanceOf(
    InvalidAddress,
  );
  expect(world.submitted).toHaveLength(0);
});

test("unlisted external destinations accept no memo and expose that a memo is optional", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const destination = addressOf(Keypair.random());
  const order = orderFor(key, AddressRecipient.make({ value: destination }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected external draft");

  expect(draft.recipient).toEqual(new ExternalRecipient({ address: destination }));
  expect(draft.memoRequired).toBe(false);
  const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

  if (!(facts instanceof PaymentFacts)) throw new Error("Expected payment facts");

  expect(facts.memo).toBeUndefined();
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(Pending);

  const signed = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(order.id))),
  );

  if (!(signed instanceof Authorized)) throw new Error("Expected authorization");

  expect(signed.order.memo).toBeUndefined();
  const outer = TransactionBuilder.fromXDR(signed.sealed.envelope, networkPassphrase);

  if (!(outer instanceof FeeBumpTransaction)) throw new Error("Expected fee bump");

  expect(outer.innerTransaction.memo.type).toBe("none");
  world.evidence.set(signed.sealed.hash, new Applied({ at: DateTime.nowUnsafe() }));
  const receipt = await send(order);

  if (!(receipt instanceof Settled)) throw new Error("Expected settled receipt");

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
  expect(Option.isNone(await runStores(Transfers.use((service) => service.find(order.id))))).toBe(
    true,
  );
  expect(world.submitted).toHaveLength(initialSubmissions);
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

  const first = await runStores(Directory.use((directory) => directory.recoverable));

  expect(first).toHaveLength(sweepBatchSize);
  expect(first.some((row) => row.address === addresses[0] || row.address === addresses[1])).toBe(
    false,
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(
        sql`update wallets set "recoveryMinTime" = now() - interval '1 minute', "recoveryMaxTime" = now() + interval '1 hour' where address = ${addresses[0]}`,
      );
    }).pipe(Effect.provide(dbLayer)),
  );

  const second = await runStores(Directory.use((directory) => directory.recoverable));

  expect(second).toHaveLength(sweepBatchSize);
  expect(second.some((row) => row.address === addresses[0])).toBe(true);
});

test("username payments still pin the Orchid recipient and settle normally", async () => {
  const key = Keypair.random();
  const recipient = Keypair.random();

  await create(key, "maria");
  await create(recipient, "rosa");
  world.accounts.set(addressOf(key), {
    sequence: "1000",
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Usdc)("50000000")),
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
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(Pending);

  const stored = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(order.id))),
  );

  if (!(stored instanceof Authorized)) throw new Error("Expected authorization");

  world.evidence.set(stored.sealed.hash, new Applied({ at: DateTime.nowUnsafe() }));
  expect(await send(order)).toBeInstanceOf(Settled);
});

test("a new registry entry blocks an unsigned draft but preserves an authorized external transfer", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const destination = addressOf(Keypair.random());
  const order = orderFor(key, AddressRecipient.make({ value: destination }));
  const draft = await send(order);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  registerExchange(destination);
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(ExternalMemoRequired);
  expect(
    Option.getOrThrow(await runStores(Transfers.use((service) => service.find(order.id)))),
  ).toBeInstanceOf(Proposed);
  world.exchangeMemos.length = 0;
  expect(await send(order, approve(draft.request, key))).toBeInstanceOf(Pending);
  registerExchange(destination);
  expect(await send(order)).toBeInstanceOf(Pending);
});

test("transfer sweep queue caps and rotates signed work across senders", async () => {
  const ids = new Array<TransferId>();

  for (let index = 0; index < sweepBatchSize + 1; index++) {
    const key = Keypair.random();

    await create(key, `sender_${index}`);
    world.accounts.set(addressOf(key), {
      sequence: "1000",
      nativeBalance: 0n,
      balance: Option.some(Schema.decodeSync(Usdc)("50000000")),
      ledger: 100,
      accountSponsored: true,
      sponsored: true,
    });

    const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
    const draft = await send(order);

    if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

    await send(order, approve(draft.request, key));
    ids.push(order.id);
  }

  const first = await runStores(Transfers.use((service) => service.inFlight));
  const next = await runStores(Transfers.use((service) => service.inFlight));
  const seen = new Set([...first, ...next].map((transfer) => transfer.order.id));

  expect(first).toHaveLength(sweepBatchSize);
  expect(next).toHaveLength(sweepBatchSize);
  expect(seen.size).toBe(ids.length);
});

const fundHolder = (key: Keypair, sequence = "1000") =>
  world.accounts.set(addressOf(key), {
    sequence,
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Usdc)("50000000")),
  });

const paymentSequence = (draft: TransferDraft) => {
  const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

  if (!(facts instanceof PaymentFacts)) throw new Error("Expected payment facts");

  return facts.sequence;
};

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

  if (!(firstDraft instanceof TransferDraft) || !(secondDraft instanceof TransferDraft))
    throw new Error("Expected drafts");

  expect(paymentSequence(firstDraft)).toBe("1001");
  expect(paymentSequence(secondDraft)).toBe("1001");
  await send(first, approve(firstDraft.request, key));

  const signed = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(first.id))),
  );

  if (!(signed instanceof Authorized)) throw new Error("Expected authorization");

  fundHolder(key, "1001");
  world.evidence.set(signed.sealed.hash, new Applied({ at: DateTime.nowUnsafe() }));
  expect(await send(first)).toBeInstanceOf(Settled);

  const redrafted = await send(second, approve(secondDraft.request, key));

  if (!(redrafted instanceof TransferDraft)) throw new Error("Expected redraft");

  expect(paymentSequence(redrafted)).toBe("1002");
  expect(
    Option.getOrThrow(await runStores(Transfers.use((service) => service.find(second.id)))),
  ).toBeInstanceOf(Proposed);
  expect(await send(second, approve(redrafted.request, key))).toBeInstanceOf(Pending);
});

test("SlotTaken reconciliation refreshes the waiting draft after the holder consumes its sequence", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const first = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const second = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const firstDraft = await send(first);
  const secondDraft = await send(second);

  if (!(firstDraft instanceof TransferDraft) || !(secondDraft instanceof TransferDraft))
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
    Wallet.use((wallet) => wallet.transfer(second, approve(secondDraft.request, key))).pipe(
      Effect.provide(finishingWallet),
    ),
  );

  if (!(result instanceof TransferDraft)) throw new Error("Expected redraft");

  expect(paymentSequence(result)).toBe("1002");
  expect(await send(second, approve(result.request, key))).toBeInstanceOf(Pending);
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

  if (!(signed instanceof Authorized)) throw new Error("Expected authorization");

  fundHolder(key, "1001");
  world.evidence.set(signed.sealed.hash, new Rejected({ code: "sequence_consumed" }));
  await run(Wallet.use((wallet) => wallet.sweep));
  expect(await send(order)).toBeInstanceOf(Failed);
  expect(await runStores(Transfers.use((service) => service.inFlight))).toHaveLength(0);

  const next = await send(orderFor(key, AddressRecipient.make({ value: addressOf(key) })));

  if (!(next instanceof TransferDraft)) throw new Error("Expected next draft");

  expect(paymentSequence(next)).toBe("1002");
});

test("an unsigned newer draft cannot hide the latest authorized or settled receipt", async () => {
  const key = Keypair.random();

  await create(key, "maria");
  fundHolder(key);

  const first = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const second = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));
  const draft = await send(first);

  if (!(draft instanceof TransferDraft)) throw new Error("Expected draft");

  await send(second);
  await send(first, approve(draft.request, key));

  const signed = Option.getOrThrow(
    await runStores(Transfers.use((service) => service.find(first.id))),
  );

  if (!(signed instanceof Authorized)) throw new Error("Expected authorization");

  world.evidence.set(signed.sealed.hash, new Applied({ at: DateTime.nowUnsafe() }));

  expect(await send(first)).toBeInstanceOf(Settled);

  const overview = await run(Wallet.use((wallet) => wallet.overview(addressOf(key))));

  if (!(overview instanceof Holding)) throw new Error("Expected holding");

  expect(Option.getOrThrow(overview.latest).id).toBe(first.id);
  expect(Option.getOrThrow(overview.latest)).toBeInstanceOf(Settled);
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
      const destination = addressOf(Keypair.random());

      if (required) registerExchange(destination);

      const order = new TransferOrder({
        ...orderFor(key, AddressRecipient.make({ value: destination })),
        memo: Schema.decodeUnknownSync(PaymentMemo)(memo),
      });

      const draft = await send(order);

      if (!(draft instanceof TransferDraft)) throw new Error("Expected memo draft");

      expect(draft.recipient).toBeInstanceOf(ExternalRecipient);
      expect(draft.memoRequired).toBe(required);
      const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

      if (!(facts instanceof PaymentFacts)) throw new Error("Expected payment facts");

      expect(facts.memo).toEqual(memo);
      await send(order, approve(draft.request, key));

      const signed = Option.getOrThrow(
        await runStores(Transfers.use((service) => service.find(order.id))),
      );

      if (!(signed instanceof Authorized)) throw new Error("Expected authorization");

      expect(signed.order.memo).toEqual(memo);
      world.evidence.set(signed.sealed.hash, new Applied({ at: DateTime.nowUnsafe() }));

      const receipt = await send(order);

      if (!(receipt instanceof Settled)) throw new Error("Expected receipt");

      expect(receipt.memo).toEqual(memo);
      expect(receipt.recipient).toEqual(new ExternalRecipient({ address: destination }));

      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase();

          return yield* db.execute(sql`select recipient from transfers where id = ${order.id}`);
        }).pipe(Effect.provide(dbLayer)),
      );

      expect(rows.rows[0]?.recipient).toBeNull();
    }
  }

  registerExchange(addressOf(key));
  const plain = await send(orderFor(key, AddressRecipient.make({ value: addressOf(key) })));

  if (!(plain instanceof TransferDraft)) throw new Error("Expected Orchid draft");

  expect(plain.memoRequired).toBe(false);

  const orchid = new TransferOrder({
    ...orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
    memo: Schema.decodeSync(PaymentMemo)({ type: "text", value: "unwanted" }),
  });

  expect(await send(orchid)).toBeInstanceOf(MemoNotAllowed);
  expect(Option.isNone(await runStores(Transfers.use((service) => service.find(orchid.id))))).toBe(
    true,
  );
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

  const advancingWallet = Wallet.serviceLayer.pipe(Layer.provide(stores), Layer.provide(advancing));

  const result = await Effect.runPromise(
    Wallet.use((wallet) => wallet.transfer(order, approve(draft.request, key))).pipe(
      Effect.provide(advancingWallet),
    ),
  );

  if (!(result instanceof TransferDraft)) throw new Error("Expected redraft");

  expect(paymentSequence(result)).toBe("1002");
  expect(
    Option.getOrThrow(await runStores(Transfers.use((service) => service.find(order.id)))),
  ).toBeInstanceOf(Proposed);
  expect(await runStores(Transfers.use((service) => service.inFlight))).toHaveLength(0);
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
    Chain.use((chain) => chain.draftPayment(order.from, addressOf(key), order.amount)).pipe(
      Effect.provide(fakeChain),
    ),
  );

  const saved = await runStores(Transfers.use((service) => service.redraft(proposed, replacement)));

  if (!(saved instanceof Authorized)) throw new Error("Expected frozen authorization");

  const outer = TransactionBuilder.fromXDR(saved.sealed.envelope, networkPassphrase);

  if (!(outer instanceof FeeBumpTransaction)) throw new Error("Expected fee bump");

  expect(outer.innerTransaction.sequence).toBe("1001");
});

test("existing wallet rows migrate into permanent name bindings", async () => {
  const folder = `${import.meta.dir}/../drizzle`;
  const before = await mkdtemp(join(tmpdir(), "orchid-wallet-migrations-"));
  const scratchName = `wallet_migration_${crypto.randomUUID().replaceAll("-", "")}`;

  const control = (statement: ReturnType<typeof sql>) =>
    Effect.runPromise(
      makeDatabase().pipe(
        Effect.flatMap((db) => db.execute(statement)),
        Effect.provide(dbLayer),
      ),
    );

  const scratchLayer = databaseLayer({
    connectionString: `postgres://orchid:orchid-local@127.0.0.1:55433/${scratchName}`,
  });

  const keys = Array.from({ length: 7 }, () => Keypair.random());

  const [unsigned, signedClaim, legacyClaim, opened, reopening, active, recovered] =
    keys.map(addressOf);

  // The two migrations that existed before usernames moved to their own table.
  for (const name of (await readdir(folder)).sort().slice(0, 2))
    await cp(join(folder, name), join(before, name), { recursive: true });

  await control(sql.raw(`create database ${scratchName}`));

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDatabase();

        yield* migrate(db, { migrationsFolder: before });

        const row = (
          address: AccountAddress | undefined,
          username: string,
          status: string,
          extra: string,
        ) =>
          db.execute(
            sql.raw(
              `insert into wallets (address, username, status, "ownershipBound", network, "testnetEpoch", "attemptEnvelope", "attemptHash", "attemptExpiresAt", "recoveryDraft", "recoveryEnvelope", "recoveryHash", "recoverySequence", "recoveryMinTime", "recoveryMaxTime") values ('${address}', '${username}', '${status}', ${extra})`,
            ),
          );

        const recovery = `'draft', 'envelope', 'hash', '1001', now(), now() + interval '1 day'`;

        yield* row(
          unsigned,
          "unsigned",
          "claimed",
          `false, 'testnet', 'before-2026-12-16', 'draft', null, now(), null, null, null, null, null, null`,
        );
        yield* row(
          signedClaim,
          "signed",
          "claimed",
          `false, 'testnet', 'before-2026-12-16', 'sealed', 'hash', now(), null, null, null, null, null, null`,
        );
        yield* row(
          legacyClaim,
          "legacy",
          "claimed",
          `true, 'testnet', 'before-2026-12-16', 'draft', null, now(), null, null, null, null, null, null`,
        );
        yield* row(
          opened,
          "opened",
          "opening",
          `true, 'testnet', 'before-2026-12-16', 'sealed', 'hash', now(), 'draft', null, null, null, null, now() + interval '1 day'`,
        );
        yield* row(
          reopening,
          "reopening",
          "reopening",
          `true, 'testnet', 'before-2026-12-16', 'draft', null, now(), null, null, null, null, null, null`,
        );
        yield* row(
          active,
          "active",
          "active",
          `true, 'testnet', 'before-2026-12-16', 'sealed', 'hash', now(), ${recovery}`,
        );
        yield* row(
          recovered,
          "recovered",
          "recovered",
          `true, 'testnet', 'before-2026-12-16', 'sealed', 'hash', now(), ${recovery}`,
        );

        yield* migrate(db, { migrationsFolder: folder });
      }).pipe(Effect.provide(scratchLayer)),
    );

    const migrated = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDatabase();
        const names = yield* db.select().from(usernames).orderBy(usernames.username);
        const rows = yield* db.select().from(wallets);

        return { names, rows };
      }).pipe(Effect.provide(scratchLayer)),
    );

    expect(migrated.names.map((name) => [name.username, name.address])).toEqual([
      ["active", active],
      ["legacy", legacyClaim],
      ["opened", opened],
      ["recovered", recovered],
      ["reopening", reopening],
      ["signed", signedClaim],
    ]);

    const status = new Map(migrated.rows.map((row) => [row.address, row]));

    expect(status.get(unsigned)?.status).toBe("opening");
    expect(status.get(signedClaim)?.status).toBe("opening");
    expect(status.get(legacyClaim)?.status).toBe("opening");
    expect(status.get(opened)?.status).toBe("opening");
    expect(status.get(reopening)?.status).toBe("recovered");
    expect(status.get(reopening)?.attemptEnvelope).toBe("draft");
    expect(status.get(active)?.status).toBe("active");
    expect(status.get(recovered)?.status).toBe("recovered");
    expect(status.get(recovered)?.recoveryEnvelope).toBeNull();
    expect(status.get(recovered)?.attemptHash).toBeNull();

    // The released name is free; the migrated recovered wallet reopens with its own name.
    const scratchWallet = Wallet.serviceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(Directory.layer, Transfers.layer).pipe(Layer.provide(scratchLayer)),
      ),
      Layer.provide(fakeChain),
    );

    const reopen = (claim: WalletClaim, approval: Option.Option<Approval> = Option.none()) =>
      Effect.runPromise(
        Wallet.use((wallet) => wallet.open(claim, approval)).pipe(Effect.provide(scratchWallet)),
      );

    const recoveredKey = keys[6] ?? Keypair.random();
    const claim = claimFor(recoveredKey, "recovered");

    expect(await reopen(claimFor(Keypair.random(), "unsigned"))).toBeInstanceOf(OpeningDraft);
    expect(await reopen(claimFor(Keypair.random(), "signed"))).toBeInstanceOf(UsernameTaken);

    const draft = await reopen(claim);

    if (!(draft instanceof OpeningDraft)) throw new Error("Expected reopening draft");

    expect(await reopen(claim, approve(draft.request, recoveredKey))).toBeInstanceOf(
      OpeningPending,
    );

    const recoveryStep = await reopen(claim);

    if (!(recoveryStep instanceof RecoveryDraft)) throw new Error("Expected recovery draft");

    expect(await reopen(claim, approve(recoveryStep.request, recoveredKey))).toEqual(
      new Opened({ profile: new Profile(claim) }),
    );
  } finally {
    await control(sql.raw(`drop database if exists ${scratchName} with (force)`));
    await rm(before, { recursive: true, force: true });
  }
});
