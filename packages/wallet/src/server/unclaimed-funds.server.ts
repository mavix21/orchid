import type * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type {
  AccountAddress,
  Asset,
  PositiveAmount,
  UnclaimedFundsId,
} from "../contract";

export interface Claim {
  readonly opensAt: Option.Option<DateTime.Utc>;
  claimableAt(at: DateTime.Utc): boolean;
}

export interface UnclaimedFundsEntry {
  readonly unclaimedFunds: UnclaimedFundsId;
  readonly asset: Asset;
  readonly amount: PositiveAmount;
  claimOf(account: AccountAddress): Option.Option<Claim>;
  paymentLinkFrom(sender: AccountAddress): Option.Option<AccountAddress>;
}

export interface RecoverablePaymentLink {
  readonly unclaimedFunds: UnclaimedFundsId;
  readonly address: AccountAddress;
  readonly asset: Asset;
  readonly amount: PositiveAmount;
}

export const recoverablePaymentLinks = (
  entries: ReadonlyArray<UnclaimedFundsEntry>,
  sender: AccountAddress,
): ReadonlyArray<RecoverablePaymentLink> =>
  entries.flatMap(({ unclaimedFunds, asset, amount, paymentLinkFrom }) =>
    Option.toArray(
      Option.map(paymentLinkFrom(sender), (address) => ({
        unclaimedFunds,
        address,
        asset,
        amount,
      })),
    ),
  );
