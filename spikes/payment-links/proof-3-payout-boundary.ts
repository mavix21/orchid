import { Asset, Keypair, Operation, type xdr } from "@stellar/stellar-sdk";
import {
  receiveFresh,
  receivePrefunded,
  reclaim,
  mergeLink,
} from "./lib/design-a";
import { emit } from "./lib/report";
import { linkVerdict, reviewLinkAsset } from "./lib/review";
import { openLink, receiveFor } from "./lib/scenario";
import { account } from "./lib/state";
import {
  authorizeHolder,
  clawbackBalance,
  clearIssuerClawback,
  openRestricted,
} from "./lib/restricted";
import {
  accountFacts,
  balanceExists,
  execute,
  exists,
  fateOf,
  lineFacts,
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

const proof = "3";
const amount = "25";

const world = await openWorld(2);
const [channelZero, channelOne] = world.channels;

if (channelZero === undefined || channelOne === undefined)
  throw new Error("Two channels are required");

const wallet = await openWallet(world);

await sponsorCounters(proof, "baseline", world);

for (const round of [1, 2, 3, 4]) {
  const label = `race receive against refund, round ${round}`;
  const open = await openLink(proof, label, world, amount);

  const outcomes = await Promise.all([
    execute(
      proof,
      `${label}: receive`,
      await receiveFresh(
        world,
        channelZero,
        open.link,
        receiveFor(open, wallet.publicKey()),
      ),
    ),
    execute(
      proof,
      `${label}: sender reclaim`,
      await reclaim(world, open.balanceId),
    ),
  ]);

  emit(proof, `${label}: state`, undefined, {
    receiveStatus: outcomes[0].status,
    reclaimStatus: outcomes[1].status,
    exactlyOneWon:
      outcomes.filter((outcome) => outcome.status === "SUCCESS").length === 1,
    balanceExists: await balanceExists(open.balanceId),
    linkExists: await exists(open.link.publicKey()),
    ledgerEvidence: await fateOf(open.balanceId),
  });

  if (await exists(open.link.publicKey()))
    await execute(
      proof,
      `${label}: merge`,
      await mergeLink(world, open.link.publicKey()),
    );

  await sponsorCounters(proof, label, world);
}

const racing = await openLink(
  proof,
  "race pre-funding against receive",
  world,
  amount,
);

const raceOutcomes = await Promise.all([
  execute(
    proof,
    "race pre-funding against receive: receive",
    await receiveFresh(
      world,
      channelZero,
      racing.link,
      receiveFor(racing, wallet.publicKey()),
    ),
  ),
  execute(
    proof,
    "race pre-funding against receive: third party funds L with 1 XLM",
    bump(
      world.feePayer,
      await build(
        world.bank.publicKey(),
        [
          Operation.createAccount({
            destination: racing.link.publicKey(),
            startingBalance: "1",
          }),
        ],
        [world.bank],
      ),
    ),
  ),
]);

emit(proof, "race pre-funding against receive: state", undefined, {
  receiveStatus: raceOutcomes[0].status,
  fundingStatus: raceOutcomes[1].status,
  balanceExists: await balanceExists(racing.balanceId),
  linkVerdict: await linkVerdict(racing.link.publicKey()),
});

const prefunded = await openLink(
  proof,
  "pre-funded before receive",
  world,
  amount,
);

await execute(
  proof,
  "pre-funded before receive: third party funds L with exactly the minimum 1 XLM",
  bump(
    world.feePayer,
    await build(
      world.bank.publicKey(),
      [
        Operation.createAccount({
          destination: prefunded.link.publicKey(),
          startingBalance: "1",
        }),
      ],
      [world.bank],
    ),
  ),
);

emit(proof, "pre-funded before receive: verdict", undefined, {
  linkVerdict: await linkVerdict(prefunded.link.publicKey()),
});

await execute(
  proof,
  "pre-funded before receive: fresh-account envelope fails atomically",
  await receiveFresh(
    world,
    channelZero,
    prefunded.link,
    receiveFor(prefunded, wallet.publicKey()),
  ),
);

emit(
  proof,
  "pre-funded before receive: state after failed envelope",
  undefined,
  {
    balanceStillClaimable: await balanceExists(prefunded.balanceId),
  },
);

await sponsorCounters(proof, "before pre-funded receive", world);

await execute(
  proof,
  "pre-funded before receive: clean pre-funded envelope with L as source, no sponsor signer, no merge",
  await receivePrefunded(
    world,
    prefunded.link,
    receiveFor(prefunded, wallet.publicKey()),
  ),
);

await accountFacts(
  proof,
  "pre-funded L after receive",
  prefunded.link.publicKey(),
);

await sponsorCounters(proof, "after pre-funded receive", world);

await lineFacts(
  proof,
  "wallet after pre-funded receive",
  wallet.publicKey(),
  world.usdc,
);

const sponsorProbe = await build(
  world.sponsor.publicKey(),
  [
    Operation.accountMerge({
      destination: world.sponsor.publicKey(),
      source: prefunded.link.publicKey(),
    }),
  ],
  [world.sponsor],
);

emit(
  proof,
  "pre-funded L: sponsor-only merge attempt while L is live",
  await run(bump(world.feePayer, sponsorProbe)),
);

await accountFacts(
  proof,
  "pre-funded L after the sponsor-only attempt",
  prefunded.link.publicKey(),
);

emit(
  proof,
  "pre-funded L: the same merge with the bearer's authority",
  await run(
    bump(
      world.feePayer,
      await build(
        prefunded.link.publicKey(),
        [Operation.accountMerge({ destination: world.bank.publicKey() })],
        [prefunded.link],
      ),
    ),
  ),
);

const nonDefault: ReadonlyArray<readonly [string, xdr.Operation]> = [
  [
    "extra signer",
    Operation.setOptions({
      signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 1 },
    }),
  ],
  ["data entry", Operation.manageData({ name: "note", value: "x" })],
  ["flag set", Operation.setOptions({ setFlags: 2 })],
  [
    "raised thresholds",
    Operation.setOptions({
      masterWeight: 3,
      lowThreshold: 2,
      medThreshold: 2,
      highThreshold: 3,
    }),
  ],
];

for (const [kind, operation] of nonDefault) {
  const tampered = Keypair.random();

  await create(world.bank, [[tampered, "5"]]);
  await execute(
    proof,
    `non-default L (${kind}): modified by the key holder`,
    bump(
      world.feePayer,
      await build(tampered.publicKey(), [operation], [tampered]),
    ),
  );
  emit(proof, `non-default L (${kind}): verdict`, undefined, {
    linkVerdict: await linkVerdict(tampered.publicKey()),
  });
}

const native = Asset.native();

const nativeOpen = await openLink(
  proof,
  "native XLM link, fresh L",
  world,
  "7",
  native,
);

await execute(
  proof,
  "native XLM link, fresh L: six-operation receive",
  await receiveFresh(
    world,
    channelOne,
    nativeOpen.link,
    receiveFor(nativeOpen, wallet.publicKey()),
  ),
);

await accountFacts(
  proof,
  "native fresh L after receive",
  nativeOpen.link.publicKey(),
);

await execute(
  proof,
  "native XLM link, fresh L: merge",
  await mergeLink(world, nativeOpen.link.publicKey()),
);

await sponsorCounters(proof, "after native fresh", world);

const nativePrefunded = await openLink(
  proof,
  "native XLM link, pre-funded L",
  world,
  "7",
  native,
);

await execute(
  proof,
  "native XLM link, pre-funded L: third party funds L with 1 XLM",
  bump(
    world.feePayer,
    await build(
      world.bank.publicKey(),
      [
        Operation.createAccount({
          destination: nativePrefunded.link.publicKey(),
          startingBalance: "1",
        }),
      ],
      [world.bank],
    ),
  ),
);

await execute(
  proof,
  "native XLM link, pre-funded L: two-operation receive with L as source",
  await receivePrefunded(
    world,
    nativePrefunded.link,
    receiveFor(nativePrefunded, wallet.publicKey()),
  ),
);

await accountFacts(
  proof,
  "native pre-funded L after receive",
  nativePrefunded.link.publicKey(),
);

const noTrust = Keypair.random();

await create(world.bank, [[noTrust, "5"]]);

const noTrustOpen = await openLink(
  proof,
  "late failure: destination has no trustline",
  world,
  amount,
);

await execute(
  proof,
  "late failure: destination has no trustline: receive",
  await receiveFresh(
    world,
    channelZero,
    noTrustOpen.link,
    receiveFor(noTrustOpen, noTrust.publicKey()),
  ),
);

emit(proof, "late failure: destination has no trustline: state", undefined, {
  balanceStillClaimable: await balanceExists(noTrustOpen.balanceId),
  linkExists: await exists(noTrustOpen.link.publicKey()),
});

await sponsorCounters(proof, "after no-trustline failure", world);

const smallLine = await openWallet(world, "10");

const fullOpen = await openLink(
  proof,
  "late failure: insufficient trustline capacity",
  world,
  amount,
);

await execute(
  proof,
  "late failure: insufficient trustline capacity: receive",
  await receiveFresh(
    world,
    channelZero,
    fullOpen.link,
    receiveFor(fullOpen, smallLine.publicKey()),
  ),
);

emit(proof, "late failure: insufficient trustline capacity: state", undefined, {
  balanceStillClaimable: await balanceExists(fullOpen.balanceId),
  linkExists: await exists(fullOpen.link.publicKey()),
});

const revocable = await openRestricted(world, "revocable-clawback");
const revokedHolder = Keypair.random();

await create(world.bank, [[revokedHolder, "5"]]);

await trust(revokedHolder, revocable.asset);

await authorizeHolder(revocable, revokedHolder.publicKey(), true);

await authorizeHolder(revocable, revokedHolder.publicKey(), false);

const unauthorizedOpen = await openLink(
  proof,
  "late failure: destination trustline not authorized",
  world,
  "10",
  revocable.asset,
);

await execute(
  proof,
  "late failure: destination trustline not authorized: receive",
  await receiveFresh(
    world,
    channelZero,
    unauthorizedOpen.link,
    receiveFor(unauthorizedOpen, revokedHolder.publicKey()),
  ),
);

emit(
  proof,
  "late failure: destination trustline not authorized: state",
  undefined,
  {
    balanceStillClaimable: await balanceExists(unauthorizedOpen.balanceId),
    linkExists: await exists(unauthorizedOpen.link.publicKey()),
  },
);

const rstrWallet = Keypair.random();

await create(world.bank, [[rstrWallet, "5"]]);

await trust(rstrWallet, revocable.asset);

await authorizeHolder(revocable, rstrWallet.publicKey(), true);

const clawedOpen = await openLink(
  proof,
  "issuer clawback",
  world,
  "10",
  revocable.asset,
);

emit(
  proof,
  "issuer clawback: clawback of the open balance",
  await clawbackBalance(revocable, clawedOpen.balanceId),
);

emit(proof, "issuer clawback: state", undefined, {
  balanceExists: await balanceExists(clawedOpen.balanceId),
  ledgerEvidence: await fateOf(clawedOpen.balanceId),
});

await execute(
  proof,
  "issuer clawback: bearer receive afterwards",
  await receiveFresh(
    world,
    channelZero,
    clawedOpen.link,
    receiveFor(clawedOpen, rstrWallet.publicKey()),
  ),
);

await execute(
  proof,
  "issuer clawback: sender reclaim afterwards",
  await reclaim(world, clawedOpen.balanceId),
);

emit(proof, "issuer flag cleared: review before clearing", undefined, {
  verdict: await reviewLinkAsset(world.rosa.publicKey(), revocable.asset),
});

emit(
  proof,
  "issuer flag cleared: the issuer clears AUTH_CLAWBACK_ENABLED",
  await clearIssuerClawback(revocable),
);

emit(proof, "issuer flag cleared: flags now", undefined, {
  issuerClawbackFlag:
    (await account(revocable.issuer.publicKey()))?.flags
      .auth_clawback_enabled ?? false,
});

await lineFacts(
  proof,
  "issuer flag cleared: sender line",
  world.rosa.publicKey(),
  revocable.asset,
);

emit(proof, "issuer flag cleared: review after clearing", undefined, {
  verdict: await reviewLinkAsset(world.rosa.publicKey(), revocable.asset),
});

const lateOpen = await openLink(
  proof,
  "issuer flag cleared",
  world,
  "10",
  revocable.asset,
);

emit(
  proof,
  "issuer flag cleared: clawback of the new balance still succeeds",
  await clawbackBalance(revocable, lateOpen.balanceId),
);

emit(proof, "issuer flag cleared: ledger evidence", undefined, {
  balanceExists: await balanceExists(lateOpen.balanceId),
  ledgerEvidence: await fateOf(lateOpen.balanceId),
});

const required = await openRestricted(world, "auth-required");

const requiredOpen = await openLink(
  proof,
  "AUTH_REQUIRED issuer",
  world,
  "10",
  required.asset,
);

const requiredWallet = Keypair.random();

await create(world.bank, [[requiredWallet, "5"]]);

await trust(requiredWallet, required.asset);

await authorizeHolder(required, requiredWallet.publicKey(), true);

await execute(
  proof,
  "AUTH_REQUIRED issuer: receive from a fresh L toward an authorized wallet",
  await receiveFresh(
    world,
    channelZero,
    requiredOpen.link,
    receiveFor(requiredOpen, requiredWallet.publicKey()),
  ),
);

emit(proof, "AUTH_REQUIRED issuer: state", undefined, {
  balanceStillClaimable: await balanceExists(requiredOpen.balanceId),
});

await execute(
  proof,
  "AUTH_REQUIRED issuer: sender reclaim",
  await reclaim(world, requiredOpen.balanceId),
);

await sponsorCounters(proof, "after restricted assets", world);
