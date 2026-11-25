import { openChannels } from "./testnet-funding";

const sponsorSecret = process.env.RESERVE_SPONSOR_SECRET;
const feePayerSecret = process.env.FEE_PAYER_SECRET;

if (sponsorSecret === undefined || feePayerSecret === undefined)
  throw new Error("Set RESERVE_SPONSOR_SECRET and FEE_PAYER_SECRET.");

console.log(
  `Opened ${await openChannels(sponsorSecret, feePayerSecret)} missing channels.`,
);
