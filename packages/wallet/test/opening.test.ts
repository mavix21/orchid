import { expect, test } from "bun:test";
import {
  Account,
  Transaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressRecipient,
  InvalidAddress,
  NotSponsored,
  Holding,
  NeedsReopening,
  Opened,
  OpeningDraft,
  RecoveryDraft,
  Amount,
  Username,
  UsernameTaken,
  WalletClaim,
} from "../src/contract";
import { Chain, Sealed } from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import { Wallet } from "../src/server/Wallet.server";
import { draftOpening } from "../src/stellar/envelopes";
import { networkPassphrase } from "../src/stellar/network";
import {
  stores,
  sponsor,
  feePayer,
  reserveSponsor,
  world,
  fakeChain,
  run,
  runStores,
  addressOf,
  approve,
  claimFor,
  opening,
  create,
  orderFor,
  send,
  useDisposableDatabase,
} from "./wallet-harness";

useDisposableDatabase();

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
    (
      await runStores(
        Directory.use((directory) => directory.byAddress(claim.address)),
      )
    ).pipe(Option.map((row) => row.status)),
  ).toEqual(Option.some("opening"));

  if (!(recovery instanceof RecoveryDraft))
    throw new Error("Expected recovery");

  expect(
    await opening(claim, approve(recovery.request, Keypair.random())),
  ).toEqual(recovery);
  expect(await opening(claim, approve(recovery.request, key))).toBeInstanceOf(
    Opened,
  );
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

    expect(
      await run(Wallet.use((wallet) => wallet.overview(claim.address))),
    ).toBeInstanceOf(NeedsReopening);
    expect(
      (
        await runStores(
          Directory.use((directory) => directory.byAddress(claim.address)),
        )
      ).pipe(Option.map((row) => row.status)),
    ).toEqual(Option.some("recovered"));
    await create(key, "maria");
    expect(
      await run(Wallet.use((wallet) => wallet.overview(claim.address))),
    ).toBeInstanceOf(Holding);
  }
});

test("a sealed opening outside RPC history redrafts after the ledger passes maxTime", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");

  const row = await runStores(
    Directory.use((directory) => directory.start(claim.address)),
  );

  const now = Math.floor(Date.now() / 1000);

  const envelope = draftOpening({
    source: new Account(reserveSponsor, "100"),
    address: claim.address,
    createAccount: true,
    minTime: now - 200,
    maxTime: now - 80,
  });

  const inner = TransactionBuilder.fromXDR(envelope, networkPassphrase);

  if (!(inner instanceof Transaction))
    throw new Error("Expected inner transaction");

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
    hash: Array.from(outer.hash(), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    expiresAt: DateTime.makeUnsafe((now - 80) * 1000),
  });

  expect(
    await runStores(
      Directory.use((directory) => directory.seal(row, historical, claim)),
    ),
  ).not.toBeInstanceOf(UsernameTaken);

  const retry = await opening(claim);

  expect(retry).toBeInstanceOf(OpeningDraft);
  expect(world.submitted).toHaveLength(0);
  expect(
    Option.getOrThrow(
      await runStores(
        Directory.use((directory) => directory.byAddress(claim.address)),
      ),
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

          return reads === 1
            ? Effect.succeed(Option.none())
            : real.account(address);
        },
      });
    }),
  ).pipe(Layer.provide(fakeChain));

  const transientWallet = Wallet.serviceLayer.pipe(
    Layer.provide(stores),
    Layer.provide(transient),
  );

  const result = await Effect.runPromise(
    Wallet.use((wallet) => wallet.overview(claim.address)).pipe(
      Effect.provide(transientWallet),
    ),
  );

  expect(result).toBeInstanceOf(Holding);
  expect(
    Option.getOrThrow(
      await runStores(
        Directory.use((directory) => directory.byAddress(claim.address)),
      ),
    ).status,
  ).toBe("active");
});

test("unsponsored and differently sponsored accounts never receive recovery drafts", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");

  world.accounts.set(claim.address, {
    sequence: "1000",
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("0")),
    ledger: 100,
    accountSponsored: false,
    sponsored: false,
  });
  expect(await opening(claim)).toBeInstanceOf(NotSponsored);
  expect(
    Option.isNone(
      await runStores(
        Directory.use((directory) => directory.byAddress(claim.address)),
      ),
    ),
  ).toBe(true);
  world.accounts.set(claim.address, {
    sequence: "1000",
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("0")),
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

  const claim = new WalletClaim({
    username: Schema.decodeSync(Username)("maria"),
    address: bad,
  });

  expect(await opening(claim)).toBeInstanceOf(InvalidAddress);
  expect(
    await run(Wallet.use((wallet) => wallet.overview(bad))),
  ).toBeInstanceOf(InvalidAddress);
  expect(
    Option.isNone(
      await runStores(Directory.use((directory) => directory.byAddress(bad))),
    ),
  ).toBe(true);
  expect(
    await send(orderFor(key, AddressRecipient.make({ value: bad }))),
  ).toBeInstanceOf(InvalidAddress);
  expect(world.submitted).toHaveLength(0);
});
