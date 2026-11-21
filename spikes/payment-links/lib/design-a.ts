import {
  Asset,
  Claimant,
  Keypair,
  Memo,
  Operation,
  type FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { build, bump, type World } from "./world";

type Operations = Parameters<typeof build>[1];

export interface Created {
  readonly transaction: FeeBumpTransaction;
  readonly balanceId: string;
  readonly sequence: string;
}

export interface Receive {
  readonly asset: Asset;
  readonly amount: string;
  readonly balanceId: string;
  readonly destination: string;
  readonly memo?: Memo;
  readonly cleanupSigner?: string;
}

export const createLinkBalance = async (
  world: World,
  link: string,
  amount: string,
  rosaClaimant: Claimant = new Claimant(world.rosa.publicKey()),
  asset: Asset = world.usdc,
): Promise<Created> => {
  const inner = await build(
    world.rosa.publicKey(),
    [
      Operation.beginSponsoringFutureReserves({
        sponsoredId: world.rosa.publicKey(),
        source: world.sponsor.publicKey(),
      }),
      Operation.createClaimableBalance({
        asset,
        amount,
        claimants: [new Claimant(link), rosaClaimant],
      }),
      Operation.endSponsoringFutureReserves(),
    ],
    [world.rosa, world.sponsor],
  );

  return {
    transaction: bump(world.feePayer, inner),
    balanceId: inner.getClaimableBalanceId(1),
    sequence: inner.sequence,
  };
};

const trustOps = (receive: Receive, link: string): Operations =>
  receive.asset.isNative()
    ? []
    : [
        Operation.changeTrust({
          asset: receive.asset,
          limit: receive.amount,
          source: link,
        }),
      ];

const closeOps = (receive: Receive, link: string): Operations =>
  receive.asset.isNative()
    ? []
    : [
        Operation.changeTrust({
          asset: receive.asset,
          limit: "0",
          source: link,
        }),
      ];

const payout = (receive: Receive, link: string) =>
  Operation.payment({
    destination: receive.destination,
    asset: receive.asset,
    amount: receive.amount,
    source: link,
  });

const claim = (receive: Receive, link: string) =>
  Operation.claimClaimableBalance({
    balanceId: receive.balanceId,
    source: link,
  });

export const receiveOperations = (
  world: World,
  link: string,
  receive: Receive,
): Operations => [
  Operation.beginSponsoringFutureReserves({
    sponsoredId: link,
    source: world.sponsor.publicKey(),
  }),
  Operation.createAccount({
    destination: link,
    startingBalance: "0",
    source: world.sponsor.publicKey(),
  }),
  ...trustOps(receive, link),
  claim(receive, link),
  payout(receive, link),
  ...closeOps(receive, link),
  Operation.setOptions({
    masterWeight: 0,
    lowThreshold: 1,
    medThreshold: 1,
    highThreshold: 1,
    signer: {
      ed25519PublicKey: receive.cleanupSigner ?? world.sponsor.publicKey(),
      weight: 1,
    },
    source: link,
  }),
  Operation.endSponsoringFutureReserves({ source: link }),
];

export const receiveFresh = async (
  world: World,
  channel: Keypair,
  link: Keypair,
  receive: Receive,
  withLinkSignature = true,
  lifetime = 120,
): Promise<FeeBumpTransaction> => {
  const inner = await build(
    channel.publicKey(),
    receiveOperations(world, link.publicKey(), receive),
    [channel, world.sponsor, ...(withLinkSignature ? [link] : [])],
    (builder) =>
      receive.memo === undefined ? builder : builder.addMemo(receive.memo),
    lifetime,
  );

  return bump(world.feePayer, inner);
};

export const receivePrefunded = async (
  world: World,
  link: Keypair,
  receive: Receive,
): Promise<FeeBumpTransaction> => {
  const address = link.publicKey();

  const sponsored = !receive.asset.isNative();

  const operations: Operations = [
    ...(sponsored
      ? [
          Operation.beginSponsoringFutureReserves({
            sponsoredId: address,
            source: world.sponsor.publicKey(),
          }),
        ]
      : []),
    ...trustOps(receive, address),
    claim(receive, address),
    payout(receive, address),
    ...closeOps(receive, address),
    ...(sponsored
      ? [Operation.endSponsoringFutureReserves({ source: address })]
      : []),
  ];

  const inner = await build(
    address,
    operations,
    sponsored ? [link, world.sponsor] : [link],
    (builder) =>
      receive.memo === undefined ? builder : builder.addMemo(receive.memo),
  );

  return bump(world.feePayer, inner);
};

export const reclaim = async (
  world: World,
  balanceId: string,
): Promise<FeeBumpTransaction> => {
  const inner = await build(
    world.rosa.publicKey(),
    [Operation.claimClaimableBalance({ balanceId })],
    [world.rosa],
  );

  return bump(world.feePayer, inner);
};

export const mergeLink = async (
  world: World,
  link: string,
  signer: Keypair = world.sponsor,
): Promise<FeeBumpTransaction> => {
  const inner = await build(
    link,
    [Operation.accountMerge({ destination: world.sponsor.publicKey() })],
    [signer],
  );

  return bump(world.feePayer, inner);
};

export const mergeInCreationLedger = async (
  world: World,
  link: Keypair,
): Promise<FeeBumpTransaction> => {
  const inner = await build(
    world.sponsor.publicKey(),
    [
      Operation.createAccount({
        destination: link.publicKey(),
        startingBalance: "1",
      }),
      Operation.accountMerge({
        destination: world.sponsor.publicKey(),
        source: link.publicKey(),
      }),
    ],
    [world.sponsor, link],
  );

  return bump(world.feePayer, inner);
};
