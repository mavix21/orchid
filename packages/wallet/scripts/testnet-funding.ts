import {
  Asset,
  Horizon,
  Keypair,
  NotFoundError,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { networkPassphrase, usdc } from "../src/stellar/network";

export { usdc };

const testnetRequestTimeout = 20_000;

export const horizon = new Horizon.Server(
  "https://horizon-testnet.stellar.org",
);

horizon.httpClient.defaults.timeout = testnetRequestTimeout;

const friendbotAttempts = 3;

const friendbotBackoff = 5_000;

const pause = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestFunding = (address: string) =>
  fetch(`https://friendbot.stellar.org/?addr=${address}`, {
    signal: AbortSignal.timeout(testnetRequestTimeout),
  }).then(
    (response) => `HTTP ${response.status}`,
    () => "no response",
  );

const visibleAccount = async (address: string) => {
  try {
    return await horizon.loadAccount(address);
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;

    throw new Error(`Horizon could not load ${address}`, { cause: error });
  }
};

const fundWithin = async (
  address: string,
  attemptsLeft: number,
): Promise<Horizon.AccountResponse> => {
  const outcome = await requestFunding(address);
  const account = await visibleAccount(address);

  if (account !== undefined) return account;

  if (attemptsLeft === 1)
    throw new Error(`Friendbot did not fund ${address}: ${outcome}`);

  await pause(friendbotBackoff);

  return fundWithin(address, attemptsLeft - 1);
};

export const fundWithFriendbot = (address: string) =>
  fundWithin(address, friendbotAttempts);

export const fundWithUsdc = async (address: string, amount: string) => {
  const funder = Keypair.random();

  const source = await fundWithFriendbot(funder.publicKey());

  const payment = new TransactionBuilder(source, {
    fee: "10000",
    networkPassphrase,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: "100",
        destination: address,
        destAsset: usdc,
        destAmount: amount,
        path: [],
      }),
    )
    .setTimeout(60)
    .build();

  payment.sign(funder);

  return horizon.submitTransaction(payment);
};
