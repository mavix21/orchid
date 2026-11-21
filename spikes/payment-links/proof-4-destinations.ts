import {
  Account,
  Asset,
  Keypair,
  Memo,
  MuxedAccount,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { receiveFresh, reclaim } from "./lib/design-a";
import { baseFee, horizon } from "./lib/network";
import { emit } from "./lib/report";
import { reviewDestination } from "./lib/review";
import { openLink, receiveFor } from "./lib/scenario";
import { authorizeHolder, openRestricted } from "./lib/restricted";
import {
  balanceExists,
  execute,
  lineFacts,
  memoFacts,
  sequenceOf,
  sponsorCounters,
} from "./lib/steps";
import {
  build,
  bump,
  create,
  openWallet,
  openWorld,
  run,
  trust,
} from "./lib/world";

const proof = "4";
const amount = "25";

const world = await openWorld(1);
const [channel] = world.channels;

if (channel === undefined) throw new Error("A channel is required");

const exchange = await openWallet(world);

await execute(
  proof,
  "exchange destination publishes SEP-29 config.memo_required",
  bump(
    world.feePayer,
    await build(
      exchange.publicKey(),
      [Operation.manageData({ name: "config.memo_required", value: "1" })],
      [exchange],
    ),
  ),
);

const memoCases: ReadonlyArray<readonly [string, Memo]> = [
  ["MEMO_TEXT numeric 12345", Memo.text("12345")],
  ["MEMO_ID 12345", Memo.id("12345")],
  ["MEMO_TEXT leading zeros 001234", Memo.text("001234")],
];

for (const [label, memo] of memoCases) {
  const open = await openLink(proof, label, world, amount);

  const outcome = await execute(
    proof,
    `${label}: receive to G exchange address`,
    await receiveFresh(world, channel, open.link, {
      ...receiveFor(open, exchange.publicKey()),
      memo,
    }),
  );

  await memoFacts(proof, label, outcome.hash);
}

const muxedBase = await openWallet(world);

const muxed = new MuxedAccount(
  new Account(muxedBase.publicKey(), "0"),
  "9007199254740993",
);

const muxedAddress = muxed.accountId();

const muxedOpen = await openLink(proof, "M destination", world, amount);

const muxedOutcome = await execute(
  proof,
  "M destination: receive to the full M address, no separate memo",
  await receiveFresh(
    world,
    channel,
    muxedOpen.link,
    receiveFor(muxedOpen, muxedAddress),
  ),
);

const muxedOperations = await horizon
  .operations()
  .forTransaction(muxedOutcome.hash)
  .call();

emit(proof, "M destination: operations on ledger", undefined, {
  muxedAddress,
  operations: muxedOperations.records
    .map((record) =>
      record.type === "payment"
        ? `payment to=${record.to} to_muxed=${record.to_muxed ?? "none"} to_muxed_id=${record.to_muxed_id ?? "none"}`
        : record.type,
    )
    .join("; "),
});

await lineFacts(
  proof,
  "M destination base account",
  muxedBase.publicKey(),
  world.usdc,
);

const muxedMemoOpen = await openLink(
  proof,
  "M destination with a separate memo",
  world,
  amount,
);

await execute(
  proof,
  "M destination with a separate memo: receive (informational, the device must refuse this)",
  await receiveFresh(world, channel, muxedMemoOpen.link, {
    ...receiveFor(muxedMemoOpen, muxedAddress),
    memo: Memo.text("conflict"),
  }),
);

const opening = Keypair.random();

const openingLink = await openLink(
  proof,
  "wallet opened immediately before the receive",
  world,
  amount,
);

await execute(
  proof,
  "wallet opened immediately before the receive: sponsored opening with trustline",
  bump(
    world.feePayer,
    await build(
      world.sponsor.publicKey(),
      [
        Operation.beginSponsoringFutureReserves({
          sponsoredId: opening.publicKey(),
        }),
        Operation.createAccount({
          destination: opening.publicKey(),
          startingBalance: "0",
        }),
        Operation.changeTrust({
          asset: world.usdc,
          source: opening.publicKey(),
        }),
        Operation.endSponsoringFutureReserves({ source: opening.publicKey() }),
      ],
      [world.sponsor, opening],
    ),
  ),
);

await execute(
  proof,
  "wallet opened immediately before the receive: receive",
  await receiveFresh(
    world,
    channel,
    openingLink.link,
    receiveFor(openingLink, opening.publicKey()),
  ),
);

await lineFacts(
  proof,
  "newly opened wallet after receive",
  opening.publicKey(),
  world.usdc,
);

await sponsorCounters(proof, "after opening and receive", world);

const noAccount = Keypair.random();
const noTrust = Keypair.random();
const smallLine = await openWallet(world, "10");
const revocable = await openRestricted(world, "revocable-clawback");
const revoked = Keypair.random();

await create(world.bank, [
  [noTrust, "5"],
  [revoked, "5"],
]);

await trust(revoked, revocable.asset);

await authorizeHolder(revocable, revoked.publicKey(), true);

await authorizeHolder(revocable, revoked.publicKey(), false);

const review = async (
  label: string,
  destination: string,
  asset: Asset,
  hasMemo: boolean,
) =>
  emit(proof, `pre-sign review: ${label}`, undefined, {
    verdict: await reviewDestination(destination, { asset, amount, hasMemo }),
  });

await review("existing wallet", exchange.publicKey(), world.usdc, true);

await review(
  "missing memo for a SEP-29 destination",
  exchange.publicKey(),
  world.usdc,
  false,
);

await review(
  "account does not exist",
  noAccount.publicKey(),
  world.usdc,
  false,
);

await review("no trustline", noTrust.publicKey(), world.usdc, false);

await review(
  "insufficient trustline capacity",
  smallLine.publicKey(),
  world.usdc,
  false,
);

await review(
  "trustline not authorized",
  revoked.publicKey(),
  revocable.asset,
  false,
);

await review(
  "muxed address with a separate memo",
  muxedAddress,
  world.usdc,
  true,
);

await review("muxed address, no memo", muxedAddress, world.usdc, false);

const missingMemoPayment = await run(
  bump(
    world.feePayer,
    await build(
      world.rosa.publicKey(),
      [
        Operation.payment({
          destination: exchange.publicKey(),
          asset: world.usdc,
          amount: "1",
        }),
      ],
      [world.rosa],
    ),
  ),
);

emit(
  proof,
  "ledger accepts a payment without memo to a SEP-29 destination",
  missingMemoPayment,
);

const wrongNetwork = new TransactionBuilder(
  new Account(
    world.rosa.publicKey(),
    String(BigInt(await sequenceOf(world.rosa.publicKey()))),
  ),
  { fee: baseFee, networkPassphrase: Networks.PUBLIC },
)
  .addOperation(
    Operation.payment({
      destination: exchange.publicKey(),
      asset: world.usdc,
      amount: "1",
    }),
  )
  .setTimeout(60)
  .build();

wrongNetwork.sign(world.rosa);

emit(
  proof,
  "wrong-network control: envelope signed for the public network passphrase, submitted to testnet",
  await run(bump(world.feePayer, wrongNetwork)),
);

const refusedOpen = await openLink(proof, "refused destination", world, amount);

emit(
  proof,
  "refused destination: nothing was signed, so the balance is untouched",
  undefined,
  {
    balanceStillClaimable: await balanceExists(refusedOpen.balanceId),
  },
);

await execute(
  proof,
  "refused destination: sender reclaim cleans up",
  await reclaim(world, refusedOpen.balanceId),
);
