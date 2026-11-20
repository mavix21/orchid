import {
  type AccountAddress,
  type Amount,
  type Asset,
  formatAmount,
} from "@workspace/wallet";
import * as Match from "effect/Match";

export const assetCode = (asset: Asset) =>
  Match.valueTags(asset, {
    Native: () => "XLM",
    Issued: ({ code }) => code,
  });

export const amountLabel = (amount: Amount, asset: Asset) =>
  `${formatAmount(amount)} ${assetCode(asset)}`;

export const shortAddress = (address: AccountAddress) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;
