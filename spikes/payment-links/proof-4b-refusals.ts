import { Asset, Keypair, Memo, Operation } from "@stellar/stellar-sdk";
import { mergeLink, receiveFresh, reclaim } from "./lib/design-a";
import { emit } from "./lib/report";
import { reviewDestination } from "./lib/review";
import { authorizeHolder, openRestricted } from "./lib/restricted";
import { openLink, receiveFor, type OpenLink } from "./lib/scenario";
import { counters } from "./lib/state";
import {
  balanceExists,
  execute,
  fateOf,
  lineFacts,
  sponsorCounters,
} from "./lib/steps";
import { build, bump, create, openWallet, openWorld, trust } from "./lib/world";

const proof = "4";
const amount = "25";
const solanaAddress = "4Nd1mBQtrMJVYVfKf2PX98AjfgS6jgYBPb5dtp3BDrtyMK";
const evmAddress = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

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

const noAccount = Keypair.random();
const noTrust = Keypair.random();
const smallLine = await openWallet(world, "10");
const buyingOnly = await openWallet(world, "100");
const revocable = await openRestricted(world, "revocable-clawback");
const revoked = Keypair.random();

await create(world.bank, [
  [noTrust, "5"],
  [revoked, "5"],
]);

await trust(revoked, revocable.asset);

await authorizeHolder(revocable, revoked.publicKey(), true);

await authorizeHolder(revocable, revoked.publicKey(), false);

await execute(
  proof,
  "capacity fixture: a buy offer for 90 USDC on a trustline with limit 100",
  bump(
    world.feePayer,
    await build(
      buyingOnly.publicKey(),
      [
        Operation.manageBuyOffer({
          selling: Asset.native(),
          buying: world.usdc,
          buyAmount: "90",
          price: "0.01",
        }),
      ],
      [buyingOnly],
    ),
  ),
);

await lineFacts(proof, "capacity fixture", buyingOnly.publicKey(), world.usdc);

const nativeLink = await openLink(
  proof,
  "native link",
  world,
  "7",
  Asset.native(),
);

const usdcLink = await openLink(proof, "issuer link", world, "5");

const review = async (
  label: string,
  destination: string,
  asset: Asset,
  hasMemo: boolean,
  link: string,
) =>
  emit(proof, `pre-sign review: ${label}`, undefined, {
    verdict: await reviewDestination(destination, {
      asset,
      amount,
      hasMemo,
      link,
    }),
  });

const anyLink = Keypair.random().publicKey();

await review(
  "existing wallet",
  exchange.publicKey(),
  world.usdc,
  true,
  anyLink,
);

await review(
  "missing memo for a SEP-29 destination",
  exchange.publicKey(),
  world.usdc,
  false,
  anyLink,
);

await review(
  "account does not exist",
  noAccount.publicKey(),
  world.usdc,
  false,
  anyLink,
);

await review("no trustline", noTrust.publicKey(), world.usdc, false, anyLink);

await review(
  "insufficient trustline capacity",
  smallLine.publicKey(),
  world.usdc,
  false,
  anyLink,
);

await review(
  "capacity short only because of buying liabilities",
  buyingOnly.publicKey(),
  world.usdc,
  false,
  anyLink,
);

await review(
  "trustline not authorized",
  revoked.publicKey(),
  revocable.asset,
  false,
  anyLink,
);

await review(
  "destination is the link account (native)",
  nativeLink.link.publicKey(),
  Asset.native(),
  false,
  nativeLink.link.publicKey(),
);

await review(
  "destination is the asset issuer",
  world.issuer.publicKey(),
  world.usdc,
  false,
  usdcLink.link.publicKey(),
);

await review(
  "address of another network (EVM)",
  evmAddress,
  world.usdc,
  false,
  anyLink,
);

await review(
  "address of another network (Solana)",
  solanaAddress,
  world.usdc,
  false,
  anyLink,
);

const sponsorBefore = await counters(world.sponsor.publicKey());

const selfPaid = await execute(
  proof,
  "informational: native link paid to L itself succeeds on the ledger",
  await receiveFresh(
    world,
    channel,
    nativeLink.link,
    receiveFor(nativeLink, nativeLink.link.publicKey()),
  ),
);

await execute(
  proof,
  "informational: merge of that L",
  await mergeLink(world, nativeLink.link.publicKey()),
);

const sponsorAfter = await counters(world.sponsor.publicKey());

emit(
  proof,
  "informational: the 7 XLM ended with the reserve sponsor",
  undefined,
  {
    receiveStatus: selfPaid.status,
    sponsorBalanceBeforeStroops: sponsorBefore.nativeBalance,
    sponsorBalanceAfterStroops: sponsorAfter.nativeBalance,
  },
);

const burned = await execute(
  proof,
  "informational: issued link paid to the issuer succeeds on the ledger",
  await receiveFresh(
    world,
    channel,
    usdcLink.link,
    receiveFor(usdcLink, world.issuer.publicKey()),
  ),
);

emit(
  proof,
  "informational: the USDC went to the issuer, not to a recipient",
  undefined,
  {
    receiveStatus: burned.status,
    balanceFate: await fateOf(usdcLink.balanceId),
  },
);

await execute(
  proof,
  "informational: merge of that L",
  await mergeLink(world, usdcLink.link.publicKey()),
);

const capacityLink = await openLink(
  proof,
  "buying-liabilities capacity",
  world,
  amount,
);

const capacityOutcome = await execute(
  proof,
  "ledger: receive into a trustline with limit 100, balance 0, buying liabilities 90",
  await receiveFresh(
    world,
    channel,
    capacityLink.link,
    receiveFor(capacityLink, buyingOnly.publicKey()),
  ),
);

emit(proof, "ledger: buying-liabilities capacity state", undefined, {
  receiveStatus: capacityOutcome.status,
  balanceStillClaimable: await balanceExists(capacityLink.balanceId),
});

const guarded = async (
  label: string,
  open: OpenLink,
  destination: string,
  memo?: Memo,
) => {
  const verdict = await reviewDestination(destination, {
    asset: open.asset,
    amount: open.amount,
    hasMemo: memo !== undefined,
    link: open.link.publicKey(),
  });

  emit(proof, `${label}: device review`, undefined, { verdict });

  if (verdict !== "accepted") return undefined;

  return execute(
    proof,
    `${label}: receive signed after acceptance`,
    await receiveFresh(world, channel, open.link, {
      ...receiveFor(open, destination),
      memo,
    }),
  );
};

const refusedThenReclaimed = await openLink(
  proof,
  "refused then reclaimed",
  world,
  amount,
);

await guarded(
  "refused then reclaimed",
  refusedThenReclaimed,
  exchange.publicKey(),
);

emit(
  proof,
  "refused then reclaimed: the same balance is untouched",
  undefined,
  {
    balanceId: refusedThenReclaimed.balanceId,
    balanceStillClaimable: await balanceExists(refusedThenReclaimed.balanceId),
  },
);

await execute(
  proof,
  "refused then reclaimed: the sender reclaims that same balance",
  await reclaim(world, refusedThenReclaimed.balanceId),
);

emit(proof, "refused then reclaimed: ledger evidence", undefined, {
  balanceFate: await fateOf(refusedThenReclaimed.balanceId),
});

const refusedThenCorrected = await openLink(
  proof,
  "refused then corrected",
  world,
  amount,
);

await guarded(
  "refused then corrected, first attempt",
  refusedThenCorrected,
  exchange.publicKey(),
);

await guarded(
  "refused then corrected, second attempt",
  refusedThenCorrected,
  exchange.publicKey(),
  Memo.text("001234"),
);

emit(
  proof,
  "refused then corrected: the same balance was consumed once",
  undefined,
  {
    balanceId: refusedThenCorrected.balanceId,
    balanceFate: await fateOf(refusedThenCorrected.balanceId),
  },
);

await sponsorCounters(proof, "after refusals", world);
