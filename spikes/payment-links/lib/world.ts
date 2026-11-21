import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { account } from "./state";
import { baseFee, pause, passphrase } from "./network";
import { submit } from "./outcome";
import { settle } from "./report";

export interface World {
  readonly bank: Keypair;
  readonly sponsor: Keypair;
  readonly feePayer: Keypair;
  readonly rosa: Keypair;
  readonly issuer: Keypair;
  readonly channels: ReadonlyArray<Keypair>;
  readonly usdc: Asset;
}

const friendbotAttempts = 4;

const requestFunding = (address: string) =>
  fetch(`https://friendbot.stellar.org/?addr=${address}`, {
    signal: AbortSignal.timeout(20_000),
  }).then(
    (response) => `HTTP ${response.status}`,
    () => "no response",
  );

const fundWithin = async (
  address: string,
  attemptsLeft: number,
): Promise<void> => {
  const outcome = await requestFunding(address);

  if ((await account(address)) !== undefined) return;

  if (attemptsLeft === 1)
    throw new Error(`Friendbot did not fund ${address}: ${outcome}`);

  await pause(5_000);

  return fundWithin(address, attemptsLeft - 1);
};

export const sourceOf = async (address: string) => {
  const record = await account(address);

  if (record === undefined) throw new Error(`${address} does not exist`);

  return new Account(address, record.sequence);
};

export const build = async (
  source: string,
  operations: ReadonlyArray<ReturnType<(typeof Operation)["payment"]>>,
  signers: ReadonlyArray<Keypair>,
  configure?: (builder: TransactionBuilder) => TransactionBuilder,
  lifetime = 120,
) => {
  const builder = new TransactionBuilder(await sourceOf(source), {
    fee: baseFee,
    networkPassphrase: passphrase,
  });

  const configured = configure === undefined ? builder : configure(builder);

  operations.forEach((operation) => configured.addOperation(operation));

  const transaction = configured.setTimeout(lifetime).build();

  transaction.sign(...signers);

  return transaction;
};

export const bump = (
  feePayer: Keypair,
  inner: Transaction,
  extraSigners: ReadonlyArray<Keypair> = [],
) => {
  const wrapped: FeeBumpTransaction =
    TransactionBuilder.buildFeeBumpTransaction(
      feePayer,
      baseFee,
      inner,
      passphrase,
    );

  wrapped.sign(feePayer, ...extraSigners);

  return wrapped;
};

export const run = async (transaction: Transaction | FeeBumpTransaction) =>
  settle(await submit(transaction));

export const create = async (
  bank: Keypair,
  recipients: ReadonlyArray<readonly [Keypair, string]>,
) => {
  const outcome = await run(
    await build(
      bank.publicKey(),
      recipients.map(([keypair, startingBalance]) =>
        Operation.createAccount({
          destination: keypair.publicKey(),
          startingBalance,
        }),
      ),
      [bank],
    ),
  );

  if (outcome.status !== "SUCCESS")
    throw new Error(`Account creation failed: ${outcome.result}`);
};

export const trust = async (holder: Keypair, asset: Asset, limit?: string) => {
  const outcome = await run(
    await build(
      holder.publicKey(),
      [Operation.changeTrust({ asset, limit })],
      [holder],
    ),
  );

  if (outcome.status !== "SUCCESS")
    throw new Error(`Trustline failed: ${outcome.result}`);
};

export const issue = async (
  world: World,
  destination: string,
  amount: string,
) => {
  const outcome = await run(
    await build(
      world.issuer.publicKey(),
      [
        Operation.payment({
          destination,
          asset: world.usdc,
          amount,
        }),
      ],
      [world.issuer],
    ),
  );

  if (outcome.status !== "SUCCESS")
    throw new Error(`Issuance failed: ${outcome.result}`);
};

export const openWorld = async (channelCount: number): Promise<World> => {
  const bank = Keypair.random();
  const sponsor = Keypair.random();
  const feePayer = Keypair.random();
  const rosa = Keypair.random();
  const issuer = Keypair.random();
  const channels = Array.from({ length: channelCount }, () => Keypair.random());

  await fundWithin(bank.publicKey(), friendbotAttempts);

  await create(bank, [
    [sponsor, "2000"],
    [feePayer, "500"],
    [rosa, "500"],
    [issuer, "50"],
    ...channels.map((channel): readonly [Keypair, string] => [channel, "5"]),
  ]);

  const usdc = new Asset("USDC", issuer.publicKey());

  const world: World = {
    bank,
    sponsor,
    feePayer,
    rosa,
    issuer,
    channels,
    usdc,
  };

  await trust(rosa, usdc);
  await issue(world, rosa.publicKey(), "1000");

  return world;
};

export const openWallet = async (
  world: World,
  limit?: string,
  startingBalance = "5",
) => {
  const wallet = Keypair.random();

  const outcome = await run(
    await build(
      world.bank.publicKey(),
      [
        Operation.createAccount({
          destination: wallet.publicKey(),
          startingBalance,
        }),
        Operation.changeTrust({
          asset: world.usdc,
          limit,
          source: wallet.publicKey(),
        }),
      ],
      [world.bank, wallet],
    ),
  );

  if (outcome.status !== "SUCCESS")
    throw new Error(`Wallet opening failed: ${outcome.result}`);

  return wallet;
};
