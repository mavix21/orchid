import { Horizon } from "@stellar/stellar-sdk";

export const horizon = new Horizon.Server(
  "https://horizon-testnet.stellar.org",
);

const friendbotAttempts = 3;

const friendbotTimeout = 20_000;

const friendbotBackoff = 5_000;

const pause = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestFunding = (address: string) =>
  fetch(`https://friendbot.stellar.org/?addr=${address}`, {
    signal: AbortSignal.timeout(friendbotTimeout),
  }).then(
    (response) => `HTTP ${response.status}`,
    () => "no response",
  );

const accountExists = (address: string) =>
  horizon.loadAccount(address).then(
    () => true,
    () => false,
  );

const fundWithin = async (
  address: string,
  attemptsLeft: number,
): Promise<void> => {
  const outcome = await requestFunding(address);

  if (await accountExists(address)) return;

  if (attemptsLeft === 1)
    throw new Error(`Friendbot did not fund ${address}: ${outcome}`);

  await pause(friendbotBackoff);

  return fundWithin(address, attemptsLeft - 1);
};

export const fundWithFriendbot = (address: string) =>
  fundWithin(address, friendbotAttempts);
