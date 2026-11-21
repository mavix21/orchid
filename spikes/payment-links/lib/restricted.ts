import {
  Asset,
  AuthClawbackEnabledFlag,
  AuthRequiredFlag,
  AuthRevocableFlag,
  Keypair,
  Operation,
} from "@stellar/stellar-sdk";
import { build, create, issue, run, trust, type World } from "./world";

export interface Restricted {
  readonly issuer: Keypair;
  readonly asset: Asset;
}

export type Restriction = "revocable-clawback" | "auth-required";

const flagsOf = (restriction: Restriction) =>
  restriction === "auth-required"
    ? AuthRequiredFlag | AuthRevocableFlag
    : AuthRevocableFlag | AuthClawbackEnabledFlag;

export const openRestricted = async (
  world: World,
  restriction: Restriction,
): Promise<Restricted> => {
  const issuer = Keypair.random();

  await create(world.bank, [[issuer, "10"]]);

  const flagged = await run(
    await build(
      issuer.publicKey(),
      [Operation.setOptions({ setFlags: flagsOf(restriction) })],
      [issuer],
    ),
  );

  if (flagged.status !== "SUCCESS")
    throw new Error(`Issuer flags failed: ${flagged.result}`);

  const asset = new Asset("RSTR", issuer.publicKey());

  await trust(world.rosa, asset);

  const authorized = await run(
    await build(
      issuer.publicKey(),
      [
        Operation.setTrustLineFlags({
          trustor: world.rosa.publicKey(),
          asset,
          flags: { authorized: true },
        }),
      ],
      [issuer],
    ),
  );

  if (authorized.status !== "SUCCESS")
    throw new Error(`Authorization failed: ${authorized.result}`);

  await issue({ ...world, issuer, usdc: asset }, world.rosa.publicKey(), "100");

  return { issuer, asset };
};

export const authorizeHolder = async (
  restricted: Restricted,
  holder: string,
  authorized: boolean,
) => {
  const outcome = await run(
    await build(
      restricted.issuer.publicKey(),
      [
        Operation.setTrustLineFlags({
          trustor: holder,
          asset: restricted.asset,
          flags: { authorized },
        }),
      ],
      [restricted.issuer],
    ),
  );

  if (outcome.status !== "SUCCESS")
    throw new Error(`Authorization change failed: ${outcome.result}`);
};

export const clawbackBalance = async (
  restricted: Restricted,
  balanceId: string,
) =>
  run(
    await build(
      restricted.issuer.publicKey(),
      [Operation.clawbackClaimableBalance({ balanceId })],
      [restricted.issuer],
    ),
  );
