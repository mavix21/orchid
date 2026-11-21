import { Asset, Claimant, Keypair, Operation } from "@stellar/stellar-sdk";
import { createLinkBalance } from "./lib/design-a";
import { horizon, passphrase } from "./lib/network";
import {
  candidateBalanceId,
  listForSender,
  readByReceipt,
  reclaimAlone,
  scanSequences,
  type Receipt,
} from "./lib/recovery";
import { emit } from "./lib/report";
import { balanceExists, execute, lineFacts, sequenceOf } from "./lib/steps";
import { build, create, openWorld, trust } from "./lib/world";

const proof = "5";
const amount = "25";

const world = await openWorld(0);
const orchidSponsor = world.sponsor.publicKey();
const sender = world.rosa;

const publish = async (label: string) => {
  const link = Keypair.random();
  const created = await createLinkBalance(world, link.publicKey(), amount);

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

const receipt: Receipt = { network: passphrase, balanceId: exported.balanceId };

emit(proof, "exact-key RPC read from the exported receipt", undefined, {
  network: receipt.network,
  balanceId: receipt.balanceId,
  rpc: await readByReceipt(receipt),
});

const listed = await listForSender(sender.publicKey());

emit(
  proof,
  "Horizon claimant query for the sender, no Orchid database",
  undefined,
  {
    balances: listed.length,
    withTwoClaimantsAndOrchidSponsor: listed.filter(
      (item) => item.claimants === 2 && item.sponsor === orchidSponsor,
    ).length,
    unrelated: listed.filter(
      (item) => item.claimants !== 2 || item.sponsor !== orchidSponsor,
    ).length,
  },
);

const independent = await reclaimAlone(sender, lost.balanceId);

emit(
  proof,
  "reclaim from listing: only the sender key, sender pays the fee",
  independent,
);

emit(proof, "reclaim from listing: state", undefined, {
  balanceExists: await balanceExists(lost.balanceId),
});

const viaReceipt = await reclaimAlone(sender, exported.balanceId);

emit(
  proof,
  "reclaim from the exported receipt: only the sender key",
  viaReceipt,
);

const record = await horizon
  .transactions()
  .transaction(independent.hash)
  .call();

emit(proof, "independent reclaim: transaction fee account", undefined, {
  feeAccount: record.fee_account,
  senderIsFeeAccount: record.fee_account === sender.publicKey(),
  orchidSponsorInvolved: record.fee_account === orchidSponsor,
});

const first = await publish("scan link one");
const second = await publish("scan link two");

const firstSequence = BigInt(first.sequence);
const secondSequence = BigInt(second.sequence);

emit(proof, "candidate balance ID derivation matches the ledger", undefined, {
  derivedMatches:
    candidateBalanceId(sender.publicKey(), firstSequence) === first.balanceId,
});

const narrow = await scanSequences(
  sender.publicKey(),
  firstSequence - 3n,
  secondSequence + 3n,
);

emit(proof, "sequence scan over a small known range", undefined, {
  requests: narrow.requests,
  found: narrow.found.length,
  foundBoth:
    narrow.found.includes(first.balanceId) &&
    narrow.found.includes(second.balanceId),
});

await execute(
  proof,
  "sender bumps its own sequence by 1000",
  await build(
    sender.publicKey(),
    [Operation.bumpSequence({ bumpTo: (secondSequence + 1_000n).toString() })],
    [sender],
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

const balanceOfUsdc = await horizon
  .accounts()
  .accountId(sender.publicKey())
  .call();

const held = balanceOfUsdc.balances.find(
  (line) =>
    line.asset_type !== "native" &&
    line.asset_type !== "liquidity_pool_shares" &&
    line.asset_code === "USDC",
);

await execute(
  proof,
  "sender burns its USDC back to the issuer before closing",
  await build(
    sender.publicKey(),
    [
      Operation.payment({
        destination: world.issuer.publicKey(),
        asset: world.usdc,
        amount: held?.balance ?? "0",
      }),
      Operation.changeTrust({ asset: world.usdc, limit: "0" }),
      Operation.accountMerge({ destination: world.bank.publicKey() }),
    ],
    [sender],
  ),
);

await create(world.bank, [[sender, "10"]]);

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

const relisted = await listForSender(sender.publicKey());

emit(
  proof,
  "Horizon claimant query after the sender was merged and reopened",
  undefined,
  {
    balances: relisted.length,
    scanLinksStillListed: [first, second, third].every((link) =>
      relisted.some((item) => item.id === link.balanceId),
    ),
  },
);

for (const link of [first, second, third])
  emit(
    proof,
    "reclaim after reopening: only the sender key",
    await reclaimAlone(sender, link.balanceId),
  );

await lineFacts(
  proof,
  "sender after recovering everything",
  sender.publicKey(),
  world.usdc,
);
