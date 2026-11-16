import { beforeAll, beforeEach, expect, test } from "bun:test";
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
  AddressRecipient,
  PhoneRecipient,
  Approval,
  ExternalRecipient,
  ExternalMemoRequired,
  InvalidAddress,
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
  WalletClaim,
} from "../src/contract";
import {
  type AccountState,
  Applied,
  Chain,
  ChainUnreachable,
  Sealed,
  type Settlement,
  Undecided,
} from "../src/server/Chain.server";
import { Directory, StoreFailure, Taken } from "../src/server/Directory.server";
import { Authorized, Concluded, Proposed, Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { WalletSettings } from "../src/server/settings.server";
import {
  draftOpening,
  draftPayment,
  draftRecovery,
  signingPayload,
} from "../src/stellar/envelopes";
import { networkPassphrase, sweepBatchSize } from "../src/stellar/network";

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
      draftPayment: (from, to, amount) =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);

          return request(
            draftPayment({
              source: new Account(from, world.accounts.get(from)?.sequence ?? "100"),
              to,
              amount,
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
  world.failSubmit = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(sql`truncate transfers, wallets`);
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

test("phone support is a typed refusal and name claims cannot be stolen", async () => {
  const key = Keypair.random();

  expect(await send(orderFor(key, PhoneRecipient.make({ value: "+51999999999" })))).toBeInstanceOf(
    PhoneNotSupported,
  );
  await create(key, "maria");
  expect(
    await runStores(
      Directory.use((directory) => directory.claim(claimFor(Keypair.random(), "maria"))),
    ),
  ).toBeInstanceOf(Taken);
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

test("reopening keeps the original username after the takeover lease expires", async () => {
  const key = Keypair.random();
  const claim = await create(key, "maria");

  world.accounts.delete(claim.address);
  await run(Wallet.use((wallet) => wallet.overview(claim.address)));
  expect(await opening(claim)).toBeInstanceOf(OpeningDraft);
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(
        sql`update wallets set "claimedAt" = now() - interval '1 hour' where address = ${claim.address}`,
      );
    }).pipe(Effect.provide(dbLayer)),
  );

  const attacker = claimFor(Keypair.random(), "maria");

  expect(await runStores(Directory.use((directory) => directory.claim(attacker)))).toBeInstanceOf(
    Taken,
  );

  const row = Option.getOrThrow(
    await runStores(Directory.use((directory) => directory.byAddress(claim.address))),
  );

  expect(row.status).toBe("reopening");
  expect(row.ownershipBound).toBe(true);
  expect(await opening(claim)).toBeInstanceOf(OpeningDraft);
});

test("an unsigned claim lease refreshes on activity but a truly stale first claim can expire", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");

  await opening(claim);
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(
        sql`update wallets set "claimedAt" = now() - interval '1 hour' where address = ${claim.address}`,
      );
    }).pipe(Effect.provide(dbLayer)),
  );
  await opening(claim);
  expect(
    await runStores(
      Directory.use((directory) => directory.claim(claimFor(Keypair.random(), "maria"))),
    ),
  ).toBeInstanceOf(Taken);
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      yield* db.execute(
        sql`update wallets set "claimedAt" = now() - interval '1 hour' where address = ${claim.address}`,
      );
    }).pipe(Effect.provide(dbLayer)),
  );

  const replacement = claimFor(Keypair.random(), "maria");
  const taken = await runStores(Directory.use((directory) => directory.claim(replacement)));

  expect(taken).not.toBeInstanceOf(Taken);
  expect(
    Option.isSome(
      await runStores(Directory.use((directory) => directory.byAddress(replacement.address))),
    ),
  ).toBe(true);
});

test("a sealed opening outside RPC history redrafts after the ledger passes maxTime", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");
  const row = await runStores(Directory.use((directory) => directory.claim(claim)));

  if (row instanceof Taken) throw new Error("Expected claim");

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

  await runStores(Directory.use((directory) => directory.attempt(row, historical)));

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

test("external payments are refused without creating a draft or asking for a signature", async () => {
  const key = Keypair.random();

  await create(key, "maria");

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(Keypair.random()) }));

  expect(await send(order)).toBeInstanceOf(ExternalMemoRequired);
  expect(Option.isNone(await runStores(Transfers.use((service) => service.find(order.id))))).toBe(
    true,
  );
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

test("external draft refusal does not hide an already authorized external transfer", async () => {
  const key = Keypair.random();

  await create(key, "maria");

  const recipient = new ExternalRecipient({ address: addressOf(Keypair.random()) });
  const order = orderFor(key, AddressRecipient.make({ value: recipient.address }));

  const request = await Effect.runPromise(
    Chain.use((chain) => chain.draftPayment(order.from, recipient.address, order.amount)).pipe(
      Effect.provide(fakeChain),
    ),
  );

  const proposed = await runStores(
    Transfers.use((service) => service.propose(order, recipient, request)),
  );

  if (!(proposed instanceof Proposed)) throw new Error("Expected proposal");

  expect(await send(order, approve(request, key))).toBeInstanceOf(ExternalMemoRequired);

  const sealed = await Effect.runPromise(
    Chain.use((chain) =>
      chain.seal(
        request,
        new Approval({ signature: key.sign(signingPayload(request.envelope)) }),
        order.from,
      ),
    ).pipe(Effect.provide(fakeChain)),
  );

  await runStores(Transfers.use((service) => service.authorize(proposed, sealed)));
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
