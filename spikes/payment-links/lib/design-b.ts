import {
  AuthImmutableFlag,
  Keypair,
  Memo,
  Operation,
  type FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { build, bump, type World } from "./world";

type Operations = Parameters<typeof build>[1];

export type Hardening = "plain" | "hardened";

const rosaSigner = (world: World, weight: number, link: string) =>
  Operation.setOptions({
    signer: { ed25519PublicKey: world.rosa.publicKey(), weight },
    source: link,
  });

const hardeningOps = (
  world: World,
  link: string,
  hardening: Hardening,
): Operations =>
  hardening === "plain"
    ? [rosaSigner(world, 1, link)]
    : [
        Operation.setOptions({
          masterWeight: 2,
          lowThreshold: 2,
          medThreshold: 2,
          highThreshold: 3,
          source: link,
        }),
        rosaSigner(world, 2, link),
        Operation.setOptions({
          signer: { ed25519PublicKey: world.sponsor.publicKey(), weight: 1 },
          source: link,
        }),
      ];

export const createB = async (
  world: World,
  link: Keypair,
  amount: string,
  hardening: Hardening = "plain",
): Promise<FeeBumpTransaction> => {
  const address = link.publicKey();

  const inner = await build(
    world.rosa.publicKey(),
    [
      Operation.beginSponsoringFutureReserves({
        sponsoredId: address,
        source: world.sponsor.publicKey(),
      }),
      Operation.createAccount({
        destination: address,
        startingBalance: "0",
        source: world.sponsor.publicKey(),
      }),
      Operation.changeTrust({
        asset: world.usdc,
        limit: amount,
        source: address,
      }),
      ...hardeningOps(world, address, hardening),
      Operation.endSponsoringFutureReserves({ source: address }),
      Operation.payment({
        destination: address,
        asset: world.usdc,
        amount,
      }),
    ],
    [world.rosa, world.sponsor, link],
  );

  return bump(world.feePayer, inner);
};

export const payoutOps = (
  world: World,
  link: string,
  destination: string,
  amount: string,
): Operations => [
  Operation.payment({
    destination,
    asset: world.usdc,
    amount,
    source: link,
  }),
  Operation.changeTrust({ asset: world.usdc, limit: "0", source: link }),
];

export const mergeOp = (world: World, link: string) =>
  Operation.accountMerge({
    destination: world.sponsor.publicKey(),
    source: link,
  });

export const claimB = async (
  world: World,
  link: Keypair,
  destination: string,
  amount: string,
  memo?: Memo,
): Promise<FeeBumpTransaction> => {
  const address = link.publicKey();

  const inner = await build(
    address,
    [
      ...payoutOps(world, address, destination, amount),
      mergeOp(world, address),
    ],
    [link],
    (builder) => (memo === undefined ? builder : builder.addMemo(memo)),
  );

  return bump(world.feePayer, inner);
};

export const cancelB = async (
  world: World,
  link: string,
  amount: string,
  signers: ReadonlyArray<Keypair>,
  withMerge = true,
): Promise<FeeBumpTransaction> => {
  const inner = await build(
    world.rosa.publicKey(),
    [
      ...payoutOps(world, link, world.rosa.publicKey(), amount),
      ...(withMerge ? [mergeOp(world, link)] : []),
    ],
    signers,
  );

  return bump(world.feePayer, inner);
};

export const removeRosa = async (
  world: World,
  link: Keypair,
): Promise<FeeBumpTransaction> => {
  const inner = await build(
    link.publicKey(),
    [rosaSigner(world, 0, link.publicKey())],
    [link],
  );

  return bump(world.feePayer, inner);
};

export const freezeAccount = async (
  world: World,
  link: Keypair,
): Promise<FeeBumpTransaction> => {
  const inner = await build(
    link.publicKey(),
    [Operation.setOptions({ setFlags: AuthImmutableFlag })],
    [link],
  );

  return bump(world.feePayer, inner);
};
