import { Asset, Claimant, Keypair, Operation } from "@stellar/stellar-sdk";
import { createLinkBalance } from "./lib/design-a";
import { passphrase } from "./lib/network";
import {
  candidateBalanceId,
  exportReceipt,
  classifyBalance,
  listForSender,
  type Listed,
  parseReceipt,
  readByReceipt,
  reclaimAlone,
  scanSequences,
} from "./lib/recovery";
import { emit } from "./lib/report";
import { openZeroSender } from "./lib/scenario";
import {
  accountFacts,
  balanceExists,
  execute,
  fateOf,
  lineFacts,
  sequenceOf,
} from "./lib/steps";
import { lineOf } from "./lib/state";
import { build, bump, create, openWorld, trust } from "./lib/world";

const proof = "5";
const amount = "25";
const publicNetwork = "Public Global Stellar Network ; September 2015";

const world = await openWorld(0);
const orchidSponsor = world.sponsor.publicKey();
const sender = await openZeroSender(world, "200");
const independentPayer = Keypair.random();

await create(world.bank, [[independentPayer, "20"]]);

await accountFacts(proof, "zero-XLM sender", sender.publicKey());

const onlyLinks = async (listed: ReadonlyArray<Listed>) => {
  const checked = await Promise.all(
    listed.flatMap((item) =>
      item.claimants === 2 && item.sponsor === orchidSponsor
        ? [classifyBalance(item.id).then((kind) => ({ item, kind }))]
        : [],
    ),
  );

  return checked.flatMap((entry) =>
    entry.kind === "link" ? [entry.item] : [],
  );
};

const publish = async (label: string) => {
  const link = Keypair.random();

  const created = await createLinkBalance(
    world,
    link.publicKey(),
    amount,
    undefined,
    world.usdc,
    sender,
  );

  await execute(proof, `${label}: create`, created.transaction, {
    balanceId: created.balanceId,
    sequence: created.sequence,
  });

  return created;
};

const exported = await publish("link with an exported receipt");
const lost = await publish("link whose receipt was never persisted");

await execute(
  proof,
  "unrelated claimable balance naming the sender, created by a stranger",
  await build(
    world.bank.publicKey(),
    [
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: "2",
        claimants: [new Claimant(sender.publicKey())],
      }),
    ],
    [world.bank],
  ),
);

const transferRecipient = Keypair.random();

const transfer = await createLinkBalance(
  world,
  transferRecipient.publicKey(),
  amount,
  new Claimant(
    sender.publicKey(),
    Claimant.predicateNot(Claimant.predicateBeforeRelativeTime("5")),
  ),
  world.usdc,
  sender,
);

await execute(
  proof,
  "username-transfer-shaped balance: same sponsor, two claimants, delayed sender predicate (5 seconds stands in for the 7 day delay)",
  transfer.transaction,
  { balanceId: transfer.balanceId },
);

emit(proof, "live classification of the transfer-shaped balance", undefined, {
  classification: await classifyBalance(transfer.balanceId),
});

const receiptText = exportReceipt({
  network: passphrase,
  balanceId: exported.balanceId,
});

emit(
  proof,
  "control: the zero-XLM sender reclaims without an independent fee payer",
  await reclaimAlone(sender, lost.balanceId),
);

emit(proof, "receipt for another network is refused", undefined, {
  verdict: await readByReceipt(
    parseReceipt(`${publicNetwork}|${exported.balanceId}`),
  ),
});

const receipt = parseReceipt(receiptText);

emit(proof, "exact-key RPC read from the exported receipt text", undefined, {
  network: receipt.network,
  balanceId: receipt.balanceId,
  rpc: await readByReceipt(receipt),
});

const discovery = await listForSender(sender.publicKey(), 2);

const candidates = discovery.listed.filter(
  (item) => item.claimants === 2 && item.sponsor === orchidSponsor,
);

const links = await onlyLinks(discovery.listed);

emit(proof, "paginated Horizon claimant query, no Orchid database", undefined, {
  pages: discovery.pages,
  balances: discovery.listed.length,
  withTwoClaimantsAndOrchidSponsor: candidates.length,
  decodedAsLinks: links.length,
  transferExcluded: !links.some((item) => item.id === transfer.balanceId),
  discoveredBothLinks:
    links.some((item) => item.id === exported.balanceId) &&
    links.some((item) => item.id === lost.balanceId),
});

const discoveredLost = links.find((item) => item.id !== receipt.balanceId);

if (discoveredLost === undefined) throw new Error("Nothing was discovered");

emit(
  proof,
  "reclaim of a discovered balance: sender key, independent fee payer",
  await reclaimAlone(sender, discoveredLost.id, independentPayer),
);

emit(
  proof,
  "reclaim from the receipt text: sender key, independent fee payer",
  await reclaimAlone(sender, receipt.balanceId, independentPayer),
);

const first = await publish("scan link one");
const second = await publish("scan link two");

const firstSequence = BigInt(first.sequence);
const secondSequence = BigInt(second.sequence);

const narrow = await scanSequences(
  sender.publicKey(),
  firstSequence - 3n,
  secondSequence + 3n,
);

emit(proof, "sequence scan over a small known range", undefined, {
  derivedMatchesSdk:
    candidateBalanceId(sender.publicKey(), firstSequence) === first.balanceId,
  requests: narrow.requests,
  found: narrow.found.length,
  foundBoth:
    narrow.found.includes(first.balanceId) &&
    narrow.found.includes(second.balanceId),
});

await execute(
  proof,
  "sender bumps its own sequence by 1000, fee paid by the independent payer",
  bump(
    independentPayer,
    await build(
      sender.publicKey(),
      [
        Operation.bumpSequence({
          bumpTo: (secondSequence + 1_000n).toString(),
        }),
      ],
      [sender],
    ),
  ),
);

const third = await publish("scan link after the sequence jump");

const wide = await scanSequences(
  sender.publicKey(),
  firstSequence,
  BigInt(third.sequence),
);

emit(
  proof,
  "sequence scan across the jump from the old lower bound",
  undefined,
  {
    requests: wide.requests,
    keysScanned: Number(BigInt(third.sequence) - firstSequence + 1n),
    found: wide.found.length,
  },
);

const held = await lineOf(sender.publicKey(), world.usdc);

await execute(
  proof,
  "sender burns its USDC and merges away, fee paid by the independent payer",
  bump(
    independentPayer,
    await build(
      sender.publicKey(),
      [
        Operation.payment({
          destination: world.issuer.publicKey(),
          asset: world.usdc,
          amount: held?.balance ?? "0",
        }),
        Operation.changeTrust({ asset: world.usdc, limit: "0" }),
        Operation.accountMerge({ destination: independentPayer.publicKey() }),
      ],
      [sender],
    ),
  ),
);

await execute(
  proof,
  "reopening: an independent funder supplies 2 XLM of reserves",
  bump(
    independentPayer,
    await build(
      independentPayer.publicKey(),
      [
        Operation.createAccount({
          destination: sender.publicKey(),
          startingBalance: "2",
        }),
      ],
      [independentPayer],
    ),
  ),
);

await trust(sender, world.usdc);

const reopened = BigInt(await sequenceOf(sender.publicKey()));

emit(proof, "sender account reopened with the same key", undefined, {
  reopenedSequence: reopened.toString(),
  oldLinkSequence: firstSequence.toString(),
  reopenedAboveOldLinks: reopened > BigInt(third.sequence),
});

const afterReopen = await scanSequences(
  sender.publicKey(),
  reopened - 5n,
  reopened + 50n,
);

emit(proof, "sequence scan from the reopened account lower bound", undefined, {
  requests: afterReopen.requests,
  found: afterReopen.found.length,
});

const relisted = await listForSender(sender.publicKey(), 2);

const rediscovered = await onlyLinks(relisted.listed);

emit(
  proof,
  "paginated claimant query after the sender was merged and reopened",
  undefined,
  {
    pages: relisted.pages,
    balances: relisted.listed.length,
    rediscovered: rediscovered.length,
    transferExcluded: !rediscovered.some(
      (item) => item.id === transfer.balanceId,
    ),
    allScanLinksRediscovered: [first, second, third].every((link) =>
      rediscovered.some((item) => item.id === link.balanceId),
    ),
  },
);

for (const item of rediscovered)
  emit(
    proof,
    "reclaim after reopening, discovered ID",
    await reclaimAlone(sender, item.id, independentPayer),
  );

emit(
  proof,
  "the username-transfer-shaped balance stays outstanding",
  undefined,
  {
    balanceStillClaimable: await balanceExists(transfer.balanceId),
    balanceFate: await fateOf(transfer.balanceId),
  },
);

await lineFacts(
  proof,
  "sender after recovering everything",
  sender.publicKey(),
  world.usdc,
);
