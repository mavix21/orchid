import { Asset, Networks } from "@stellar/stellar-sdk";

export const networkPassphrase = Networks.TESTNET;
export const network = "testnet";
export const testnetReset = Date.UTC(2026, 11, 16);

export function epochAt(time: number): string {
  return time < testnetReset ? "before-2026-12-16" : "2026-12-16";
}

// The base asset: its trustline is opened with the wallet and removed only by
// recovery. Every other trustline is opened on demand by an asset order.
export const usdc = new Asset(
  "USDC",
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
);

// "One base reserve is currently 0.5 XLM."
// https://developers.stellar.org/docs/learn/fundamentals/lumens#base-reserves
export const baseReserve = 5_000_000n;

// Reserve policy. An account locks two base reserves and each trustline one
// more (https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts#subentries),
// all carried by the reserve sponsor. Counting the base asset, a wallet's
// trustlines lock at most (2 + 6) * 0.5 = 4 XLM.
export const maxSponsoredTrustlines = 6;

// A claimable balance costs "a base reserve per claimant"
// (https://developers.stellar.org/docs/learn/fundamentals/lumens#minimum-balance).
// Ours name two, recipient and sender, so each locks 1 XLM of the sponsor until
// somebody claims it; a sender's unclaimed balances lock at most 2 XLM.
export const maxOpenClaimables = 2;

// How long the recipient has before the sender may take a balance back.
export const reclaimDelay = 7 * 24 * 60 * 60;

export const baseFee = "100";
export const paymentLifetime = 120;
export const approvalMargin = 20;
export const recoveryDelay = 24 * 60 * 60;
export const recoveryWindow = 7 * 24 * 60 * 60;

export const sweepBatchSize = 4;

// One overview reads at most this many claimable balances; getLedgerEntries
// accepts 200 keys (https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getLedgerEntries).
export const claimableReadLimit = 50;
