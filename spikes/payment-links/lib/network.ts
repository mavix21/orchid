import { Horizon, Networks, rpc } from "@stellar/stellar-sdk";

export const passphrase = Networks.TESTNET;

export const horizon = new Horizon.Server(
  "https://horizon-testnet.stellar.org",
);

export const rpcServer = new rpc.Server("https://soroban-testnet.stellar.org");

export const baseFee = "100";

export const stroops = 10_000_000n;

export const pause = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const toStroops = (amount: string): bigint => {
  const [whole = "0", fraction = ""] = amount.split(".");

  return BigInt(whole) * stroops + BigInt(fraction.padEnd(7, "0"));
};

export const fromStroops = (value: bigint): string => {
  const whole = value / stroops;
  const fraction = (value % stroops).toString().padStart(7, "0");

  return `${whole}.${fraction}`;
};
