import { Asset, Keypair } from "@stellar/stellar-sdk";
import { createLinkBalance, type Receive } from "./design-a";
import { execute } from "./steps";
import type { World } from "./world";

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
