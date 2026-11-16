import { Asset, Networks } from "@stellar/stellar-sdk";

export const networkPassphrase = Networks.TESTNET;
export const network = "testnet";
export const testnetReset = Date.UTC(2026, 11, 16);

export function epochAt(time: number): string {
  return time < testnetReset ? "before-2026-12-16" : "2026-12-16";
}

export const usdc = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
export const baseFee = "100";
export const paymentLifetime = 120;
export const approvalMargin = 20;
export const recoveryDelay = 24 * 60 * 60;
export const recoveryWindow = 7 * 24 * 60 * 60;
export const claimLifetime = 10 * 60;

export const sweepBatchSize = 4;
