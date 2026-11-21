import { Keypair } from "@stellar/stellar-sdk";
import { receiveFresh, reclaim } from "./lib/design-a";
import { emit } from "./lib/report";
import { openLink, receiveFor } from "./lib/scenario";
import {
  accountFacts,
  balanceExists,
  execute,
  exists,
  sponsorCounters,
} from "./lib/steps";
import { create, openWallet, openWorld } from "./lib/world";

const proof = "3";

const world = await openWorld(1);
const [channel] = world.channels;

if (channel === undefined) throw new Error("A channel is required");

const wallet = await openWallet(world);

for (const startingBalance of ["3.4999999", "3.5"]) {
  const thin = Keypair.random();

  await create(world.bank, [[thin, startingBalance]]);

  const thinWorld = { ...world, sponsor: thin };
  const label = `thin sponsor with ${startingBalance} XLM`;

  await accountFacts(proof, `${label} before`, thin.publicKey());

  const open = await openLink(proof, label, thinWorld, "25");

  await sponsorCounters(proof, `${label} after create`, thinWorld);

  const outcome = await execute(
    proof,
    `${label}: receive`,
    await receiveFresh(
      thinWorld,
      channel,
      open.link,
      receiveFor(open, wallet.publicKey()),
    ),
  );

  emit(proof, `${label}: state`, undefined, {
    receiveStatus: outcome.status,
    balanceStillClaimable: await balanceExists(open.balanceId),
    linkExists: await exists(open.link.publicKey()),
  });
  await sponsorCounters(proof, `${label} after receive`, thinWorld);

  if (!(await exists(open.link.publicKey())))
    await execute(
      proof,
      `${label}: sender reclaim`,
      await reclaim(thinWorld, open.balanceId),
    );
}
