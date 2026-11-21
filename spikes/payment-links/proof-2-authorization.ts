import {
  Asset,
  Claimant,
  Keypair,
  Memo,
  Operation,
} from "@stellar/stellar-sdk";
import {
  createLinkBalance,
  mergeInCreationLedger,
  receiveFresh,
  reclaim,
  sweep,
} from "./lib/design-a";
import { pause } from "./lib/network";
import { emit } from "./lib/report";
import {
  accountFacts,
  balanceExists,
  envelopeFacts,
  execute,
  exists,
  lineFacts,
  protocol,
  roleMap,
  sequenceOf,
  sponsorCounters,
} from "./lib/steps";
import { build, bump, openWallet, openWorld } from "./lib/world";

const proof = "2";
const amount = "25";

const world = await openWorld(2);
const [channelZero, channelOne] = world.channels;

if (channelZero === undefined || channelOne === undefined)
  throw new Error("Two channels are required");

await protocol(proof);

await sponsorCounters(proof, "baseline", world);

const link = Keypair.random();
const wallet = await openWallet(world);

const roles = roleMap(world, [
  ["L", link],
  ["wallet", wallet],
]);

const created = await createLinkBalance(world, link.publicKey(), amount);

envelopeFacts(proof, "A+ create", created.transaction, roles);

await execute(
  proof,
  "A+ create: balance naming nonexistent L",
  created.transaction,
  {
    balanceId: created.balanceId,
    linkExists: await exists(link.publicKey()),
  },
);

emit(proof, "A+ create: balance on ledger", undefined, {
  balanceExists: await balanceExists(created.balanceId),
  linkExistsAfterCreate: await exists(link.publicKey()),
});

await sponsorCounters(proof, "after A+ create", world);

const receive = {
  asset: world.usdc,
  amount,
  balanceId: created.balanceId,
  destination: wallet.publicKey(),
};

const unsigned = await receiveFresh(world, channelZero, link, receive, false);

const channelBefore = await sequenceOf(channelZero.publicKey());

await execute(proof, "negative control: receive without L signature", unsigned);

emit(proof, "negative control: state after rejection", undefined, {
  channelSequenceUnchanged:
    channelBefore === (await sequenceOf(channelZero.publicKey())),
  balanceStillClaimable: await balanceExists(created.balanceId),
  linkExists: await exists(link.publicKey()),
});

const receiveTransaction = await receiveFresh(
  world,
  channelZero,
  link,
  receive,
);

envelopeFacts(proof, "A+ receive", receiveTransaction, roles);

const received = await execute(
  proof,
  "A+ receive: eight-operation atomic envelope",
  receiveTransaction,
);

emit(proof, "A+ receive: result", undefined, {
  balanceGone: !(await balanceExists(created.balanceId)),
  receiveLedger: received.ledger ?? 0,
});

await accountFacts(proof, "L after receive", link.publicKey());

await lineFacts(proof, "wallet after receive", wallet.publicKey(), world.usdc);

await sponsorCounters(proof, "after A+ receive, before sweep", world);

const merged = await execute(
  proof,
  "next-ledger sweep: L as tx source, sponsor signature only",
  await sweep(world, link.publicKey()),
);

emit(proof, "next-ledger sweep: result", undefined, {
  sweepLedgerMinusReceiveLedger: (merged.ledger ?? 0) - (received.ledger ?? 0),
  linkExists: await exists(link.publicKey()),
});

await sponsorCounters(proof, "after sweep", world);

const creationLedgerLink = Keypair.random();

await execute(
  proof,
  "merge in the creation ledger (create and merge in one transaction)",
  await mergeInCreationLedger(world, creationLedgerLink),
);

emit(proof, "creation-ledger merge: state", undefined, {
  linkExists: await exists(creationLedgerLink.publicKey()),
});

const delayed = Keypair.random();

const delayedCreation = await createLinkBalance(
  world,
  delayed.publicKey(),
  amount,
  new Claimant(
    world.rosa.publicKey(),
    Claimant.predicateNot(Claimant.predicateBeforeRelativeTime("20")),
  ),
);

await execute(
  proof,
  "delayed predicate fixture: create with 20 second relative delay",
  delayedCreation.transaction,
  {
    balanceId: delayedCreation.balanceId,
  },
);

await execute(
  proof,
  "delayed predicate fixture: early reclaim",
  await reclaim(world, delayedCreation.balanceId),
);

await pause(25_000);

await execute(
  proof,
  "delayed predicate fixture: reclaim after delay",
  await reclaim(world, delayedCreation.balanceId),
);

await sponsorCounters(proof, "after delayed fixture", world);

const immediate = Keypair.random();

const immediateCreation = await createLinkBalance(
  world,
  immediate.publicKey(),
  amount,
);

await execute(
  proof,
  "A+ immediate reclaim: create",
  immediateCreation.transaction,
);

await sponsorCounters(proof, "after A+ create for reclaim", world);

await execute(
  proof,
  "A+ immediate reclaim: sender claims in the next ledger",
  await reclaim(world, immediateCreation.balanceId),
);

await lineFacts(
  proof,
  "sender after immediate reclaim",
  world.rosa.publicKey(),
  world.usdc,
);

await sponsorCounters(proof, "after A+ immediate reclaim", world);

const stray = Keypair.random();
const strayCreation = await createLinkBalance(world, stray.publicKey(), amount);

await execute(
  proof,
  "dust and stray balance: create",
  strayCreation.transaction,
);

await execute(
  proof,
  "dust and stray balance: receive",
  await receiveFresh(world, channelOne, stray, {
    asset: world.usdc,
    amount,
    balanceId: strayCreation.balanceId,
    destination: wallet.publicKey(),
  }),
);

const dust = await build(
  world.bank.publicKey(),
  [
    Operation.payment({
      destination: stray.publicKey(),
      asset: Asset.native(),
      amount: "3",
    }),
    Operation.createClaimableBalance({
      asset: Asset.native(),
      amount: "2",
      claimants: [new Claimant(stray.publicKey())],
    }),
  ],
  [world.bank],
);

await execute(
  proof,
  "dust and stray balance: unsolicited 3 XLM payment and 2 XLM claimable balance to L",
  bump(world.feePayer, dust),
);

await execute(
  proof,
  "dust and stray balance: sweep",
  await sweep(world, stray.publicKey()),
);

emit(proof, "dust and stray balance: result", undefined, {
  linkExists: await exists(stray.publicKey()),
});

await sponsorCounters(proof, "after dust and stray sweep", world);

const first = Keypair.random();
const second = Keypair.random();
const firstCreation = await createLinkBalance(world, first.publicKey(), amount);

await execute(
  proof,
  "concurrency: create first link",
  firstCreation.transaction,
);

const secondCreation = await createLinkBalance(
  world,
  second.publicKey(),
  amount,
);

await execute(
  proof,
  "concurrency: create second link",
  secondCreation.transaction,
);

const opening = await build(
  world.sponsor.publicKey(),
  [
    Operation.createAccount({
      destination: Keypair.random().publicKey(),
      startingBalance: "1",
    }),
  ],
  [world.sponsor],
);

const sequencesBefore = [
  await sequenceOf(world.sponsor.publicKey()),
  await sequenceOf(channelZero.publicKey()),
  await sequenceOf(channelOne.publicKey()),
];

const concurrent = await Promise.all([
  execute(
    proof,
    "concurrency: receive on channel 0",
    await receiveFresh(world, channelZero, first, {
      asset: world.usdc,
      amount,
      balanceId: firstCreation.balanceId,
      destination: wallet.publicKey(),
    }),
  ),
  execute(
    proof,
    "concurrency: receive on channel 1",
    await receiveFresh(world, channelOne, second, {
      asset: world.usdc,
      amount,
      balanceId: secondCreation.balanceId,
      destination: wallet.publicKey(),
      memo: Memo.text("sibling"),
    }),
  ),
  execute(
    proof,
    "concurrency: wallet opening sourced by the sponsor",
    bump(world.feePayer, opening),
  ),
]);

emit(proof, "concurrency: summary", undefined, {
  sponsorSequenceBefore: sequencesBefore[0] ?? "",
  channelZeroSequenceBefore: sequencesBefore[1] ?? "",
  channelOneSequenceBefore: sequencesBefore[2] ?? "",
  sponsorSequenceAfter: await sequenceOf(world.sponsor.publicKey()),
  allSucceeded: concurrent.every((outcome) => outcome.status === "SUCCESS"),
  ledgers: concurrent.map((outcome) => outcome.ledger ?? 0).join(","),
});

await execute(
  proof,
  "concurrency: sweep first link",
  await sweep(world, first.publicKey()),
);

await execute(
  proof,
  "concurrency: sweep second link",
  await sweep(world, second.publicKey()),
);

await sponsorCounters(proof, "after concurrency", world);

const reuse = Keypair.random();
const reuseCreation = await createLinkBalance(world, reuse.publicKey(), amount);

await execute(proof, "channel reuse: create", reuseCreation.transaction);

await execute(
  proof,
  "channel reuse: receive on channel 0 again",
  await receiveFresh(world, channelZero, reuse, {
    asset: world.usdc,
    amount,
    balanceId: reuseCreation.balanceId,
    destination: wallet.publicKey(),
  }),
);

await execute(
  proof,
  "channel reuse: sweep",
  await sweep(world, reuse.publicKey()),
);

await sponsorCounters(proof, "final", world);
