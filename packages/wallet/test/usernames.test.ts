import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { makeDatabase } from "@workspace/db";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AddressBound,
  PhoneRecipient,
  NeedsReopening,
  Opened,
  OpeningDraft,
  OpeningPending,
  PhoneNotSupported,
  Profile,
  RecoveryDraft,
  TransferDraft,
  Amount,
  Username,
  UsernameRecipient,
  UsernameTaken,
  UnknownRecipient,
} from "../src/contract";
import { Directory } from "../src/server/Directory.server";
import { usernames } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { RecoveryFacts, readEnvelope } from "../src/stellar/envelopes";
import {
  dbLayer,
  world,
  run,
  runStores,
  addressOf,
  approve,
  claimFor,
  opening,
  create,
  orderFor,
  send,
  placeholderRequest,
  placeholderSealed,
  fundHolder,
  useDisposableDatabase,
} from "./wallet-harness";

useDisposableDatabase();

test("phone support is a typed refusal and bound names cannot be taken by another key", async () => {
  const key = Keypair.random();

  expect(
    await send(orderFor(key, PhoneRecipient.make({ value: "+51999999999" }))),
  ).toBeInstanceOf(PhoneNotSupported);
  await create(key, "maria");

  const before = world.submitted.length;

  expect(await opening(claimFor(Keypair.random(), "maria"))).toEqual(
    new UsernameTaken({ username: Schema.decodeSync(Username)("maria") }),
  );
  expect(world.submitted).toHaveLength(before);
});

test("a name is bound only by the signed opening; drafts reserve nothing", async () => {
  const key = Keypair.random();
  const first = claimFor(key, "maria");
  const draft = await opening(first);

  if (!(draft instanceof OpeningDraft)) throw new Error("Expected draft");

  // Asking for another name before signing is not a conflict with the abandoned first choice.
  const second = claimFor(key, "maria2");
  const redraft = await opening(second);

  if (!(redraft instanceof OpeningDraft))
    throw new Error("Expected draft for the new name");

  expect(await opening(claimFor(Keypair.random(), "maria"))).toBeInstanceOf(
    OpeningDraft,
  );
  expect(await opening(second, approve(redraft.request, key))).toBeInstanceOf(
    OpeningPending,
  );
  expect(await opening(first)).toEqual(
    new AddressBound({ profile: new Profile(second) }),
  );
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

      return opening(
        claims[index] ?? claims[0],
        approve(draft.request, keys[index] ?? keys[0]),
      );
    }),
  );

  expect(
    results.filter((result) => result instanceof OpeningPending),
  ).toHaveLength(1);
  expect(
    results.filter((result) => result instanceof UsernameTaken),
  ).toHaveLength(1);
  expect(world.submitted).toHaveLength(1);

  const loser = results.findIndex((result) => result instanceof UsernameTaken);
  const key = keys[loser] ?? keys[0];
  const renamed = claimFor(key, "maria_2");
  const retry = await opening(renamed);

  if (!(retry instanceof OpeningDraft))
    throw new Error("Expected loser to redraft");

  expect(await opening(renamed, approve(retry.request, key))).toBeInstanceOf(
    OpeningPending,
  );
  expect(world.submitted).toHaveLength(2);
});

test("the binding write refuses a taken name even when the soft check is skipped", async () => {
  await create(Keypair.random(), "maria");

  const key = Keypair.random();
  const claim = claimFor(key, "maria");

  const row = await runStores(
    Directory.use((directory) => directory.start(claim.address)),
  );

  const draft = await runStores(
    Directory.use((directory) => directory.draft(row, placeholderRequest())),
  );

  const sealed = placeholderSealed();

  expect(
    await runStores(
      Directory.use((directory) => directory.seal(draft, sealed, claim)),
    ),
  ).toEqual(new UsernameTaken({ username: claim.username }));

  const stored = Option.getOrThrow(
    await runStores(
      Directory.use((directory) => directory.byAddress(claim.address)),
    ),
  );

  expect(stored.attemptHash).toBeNull();
  expect(stored.version).toBe(draft.version);
});

test("a stale binding write stores neither the attempt nor the name", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");

  const row = await runStores(
    Directory.use((directory) => directory.start(claim.address)),
  );

  const sealed = placeholderSealed();

  await runStores(
    Directory.use((directory) => directory.draft(row, placeholderRequest())),
  );

  const written = await runStores(
    Directory.use((directory) => directory.seal(row, sealed, claim)),
  );

  if (written instanceof UsernameTaken || written instanceof AddressBound)
    throw new Error("Expected the current row back");

  expect(written.attemptHash).toBeNull();
  expect(await opening(claimFor(Keypair.random(), "maria"))).toBeInstanceOf(
    OpeningDraft,
  );
});

test("reserved names are never bound", async () => {
  const key = Keypair.random();

  const impersonations = [
    // Anything containing "orchid".
    "orchid",
    "orchid_help",
    "orchidsupport",
    "orchid_oficial",
    "my_orchid",
    // Exact reserved words in English and Spanish.
    "support",
    "admin",
    "security",
    "wallet",
    "official",
    "soporte",
    "ayuda",
    "seguridad",
    "oficial",
    "equipo",
    "billetera",
    "administrador",
  ];

  for (const name of impersonations) {
    expect(await opening(claimFor(key, name))).toEqual(
      new UsernameTaken({ username: Schema.decodeSync(Username)(name) }),
    );
  }

  expect(
    Option.isNone(
      await runStores(
        Directory.use((directory) => directory.byAddress(addressOf(key))),
      ),
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
  expect(
    await run(Wallet.use((wallet) => wallet.overview(claim.address))),
  ).toEqual(new NeedsReopening({ profile: new Profile(claim) }));

  const order = orderFor(
    sender,
    UsernameRecipient.make({ value: claim.username }),
  );

  expect(await send(order)).toBeInstanceOf(UnknownRecipient);
  expect(await opening(claimFor(Keypair.random(), "maria"))).toBeInstanceOf(
    UsernameTaken,
  );
  expect(await opening(claimFor(key, "maria2"))).toEqual(
    new AddressBound({ profile: new Profile(claim) }),
  );

  const draft = await opening(claim);

  if (!(draft instanceof OpeningDraft))
    throw new Error("Expected reopening draft");

  // Repair is in progress: the wallet stays recovered and unpayable until activation.
  await opening(claim, approve(draft.request, key));
  expect(
    await run(Wallet.use((wallet) => wallet.overview(claim.address))),
  ).toBeInstanceOf(NeedsReopening);
  expect(await send(order)).toBeInstanceOf(UnknownRecipient);

  const recovery = await opening(claim);

  if (!(recovery instanceof RecoveryDraft))
    throw new Error("Expected recovery draft");

  expect(await opening(claim, approve(recovery.request, key))).toBeInstanceOf(
    Opened,
  );
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
    balance: Option.some(Schema.decodeSync(Amount)("0")),
  });

  const recovery = await opening(claim);

  if (!(recovery instanceof RecoveryDraft))
    throw new Error("Expected recovery draft");

  expect(await opening(claim, approve(recovery.request, key))).toEqual(
    new Opened({ profile: new Profile(claim) }),
  );
  expect(await opening(claimFor(Keypair.random(), "maria"))).toBeInstanceOf(
    UsernameTaken,
  );
  expect(world.submitted).toHaveLength(0);
});

test("a name bound before it was reserved stays usable by its address", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "soporte");

  const row = await runStores(
    Directory.use((directory) => directory.start(claim.address)),
  );

  await Effect.runPromise(
    makeDatabase().pipe(
      Effect.flatMap((db) => db.insert(usernames).values(claim)),
      Effect.provide(dbLayer),
    ),
  );

  expect(
    await runStores(
      Directory.use((directory) =>
        directory.seal(row, placeholderSealed(), claim),
      ),
    ),
  ).not.toBeInstanceOf(UsernameTaken);
  expect(await opening(claimFor(Keypair.random(), "soporte"))).toBeInstanceOf(
    UsernameTaken,
  );
});

test("activation refuses a name another key bound after the recovery draft", async () => {
  const key = Keypair.random();
  const claim = claimFor(key, "maria");

  world.accounts.set(claim.address, {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("0")),
  });

  const recovery = await opening(claim);

  if (!(recovery instanceof RecoveryDraft))
    throw new Error("Expected recovery draft");

  const row = Option.getOrThrow(
    await runStores(
      Directory.use((directory) => directory.byAddress(claim.address)),
    ),
  );

  const facts = Option.getOrThrow(readEnvelope(recovery.request.envelope));

  if (!(facts instanceof RecoveryFacts))
    throw new Error("Expected recovery facts");

  // Another key binds the name after this soft check passed; the activation bind must refuse.
  await create(Keypair.random(), "maria");
  expect(
    await runStores(
      Directory.use((directory) =>
        directory.activate(row, placeholderSealed(), facts, claim),
      ),
    ),
  ).toEqual(new UsernameTaken({ username: claim.username }));
  expect(
    Option.getOrThrow(
      await runStores(
        Directory.use((directory) => directory.byAddress(claim.address)),
      ),
    ).status,
  ).toBe("opening");
});

test("a new user is payable by username immediately after activation", async () => {
  const sender = Keypair.random();
  const recipient = Keypair.random();

  await create(sender, "rosa");
  fundHolder(sender);

  const order = orderFor(
    sender,
    UsernameRecipient.make({ value: Schema.decodeSync(Username)("maria") }),
  );

  expect(await send(order)).toBeInstanceOf(UnknownRecipient);
  await create(recipient, "maria");

  const draft = await send(order);

  if (!(draft instanceof TransferDraft))
    throw new Error("Expected draft to the new user");

  expect(draft.recipient.address).toBe(addressOf(recipient));
});
