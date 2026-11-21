import { Asset, Keypair, Operation } from "@stellar/stellar-sdk";
import { createLinkBalance, type Receive } from "./design-a";
import { execute } from "./steps";
import { build, bump, issue, run, type World } from "./world";

export interface OpenLink {
  readonly link: Keypair;
  readonly balanceId: string;
  readonly amount: string;
  readonly asset: Asset;
}

export const openLink = async (
  proof: string,
  label: string,
  world: World,
  amount: string,
  asset: Asset = world.usdc,
): Promise<OpenLink> => {
  const link = Keypair.random();

  const created = await createLinkBalance(
    world,
    link.publicKey(),
    amount,
    undefined,
    asset,
  );

  await execute(proof, `${label}: create`, created.transaction, {
    balanceId: created.balanceId,
  });

  return { link, balanceId: created.balanceId, amount, asset };
};

export const receiveFor = (open: OpenLink, destination: string): Receive => ({
  asset: open.asset,
  amount: open.amount,
  balanceId: open.balanceId,
  destination,
});

export const openZeroSender = async (world: World, usdcAmount: string) => {
  const sender = Keypair.random();

  const opening = await build(
    world.sponsor.publicKey(),
    [
      Operation.beginSponsoringFutureReserves({
        sponsoredId: sender.publicKey(),
      }),
      Operation.createAccount({
        destination: sender.publicKey(),
        startingBalance: "0",
      }),
      Operation.changeTrust({ asset: world.usdc, source: sender.publicKey() }),
      Operation.endSponsoringFutureReserves({ source: sender.publicKey() }),
    ],
    [world.sponsor, sender],
  );

  const outcome = await run(bump(world.feePayer, opening));

  if (outcome.status !== "SUCCESS")
    throw new Error(`Zero-XLM sender opening failed: ${outcome.result}`);

  await issue(world, sender.publicKey(), usdcAmount);

  return sender;
};
