import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  type AccountAddress,
  type BalanceId,
  InvalidAddress,
  NotOpened,
  OpenPaymentLink,
  OpenPaymentLinks,
  PaymentLinkNotFound,
  type PaymentLinkReceipt,
  PaymentLinkReceiptInvalid,
  type PaymentLinksStep,
  type ResolveReceiptStep,
  ResolvedPaymentLink,
  assetKey,
} from "../contract";
import { network } from "../stellar/network";
import { Chain, type ChainUnreachable } from "./Chain.server";
import { Directory, type StoreFailure } from "./Directory.server";
import { selectRecoverablePaymentLinks } from "./ledger-assets.server";
import { rpcReadConcurrency } from "./settings.server";
import { Transfers } from "./Transfers.server";

export const paymentLinksFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const directory = yield* Directory;
  const transfers = yield* Transfers;

  const closeGoneBalance = (id: BalanceId) =>
    chain
      .claimable([id])
      .pipe(
        Effect.flatMap((confirmed) =>
          confirmed.length === 0 ? transfers.closeBalance(id) : Effect.void,
        ),
      );

  const paymentLinks = Effect.fn("Wallet.paymentLinks")(function* (
    address: AccountAddress,
  ): Effect.fn.Return<PaymentLinksStep, StoreFailure | ChainUnreachable> {
    if (!chain.validAddress(address)) return new InvalidAddress({ address });

    const row = yield* directory.byAddress(address);

    if (Option.isNone(row) || row.value.status !== "active")
      return new NotOpened();

    const pendingLinks = yield* transfers.openPaymentLinks(address);

    const entries = yield* chain.claimable(
      pendingLinks.map((item) => item.balance),
    );

    const liveLinks = selectRecoverablePaymentLinks(entries, address);
    const links: OpenPaymentLink[] = [];
    const missing: BalanceId[] = [];

    for (const item of pendingLinks) {
      const matched = liveLinks.find(
        (candidate) =>
          candidate.balance === item.balance &&
          candidate.address === item.address,
      );

      if (!matched) {
        if (!entries.some((entry) => entry.balance === item.balance))
          missing.push(item.balance);

        continue;
      }

      links.push(
        new OpenPaymentLink({
          id: item.id,
          balance: item.balance,
          address: item.address,
          asset: matched.asset,
          amount: matched.amount,
          createdAt: item.createdAt,
        }),
      );
    }

    yield* Effect.forEach(missing, closeGoneBalance, {
      concurrency: rpcReadConcurrency,
      discard: true,
    });

    return new OpenPaymentLinks({ links });
  });

  const resolvePaymentLink = Effect.fn("Wallet.resolvePaymentLink")(function* (
    sender: AccountAddress,
    receipt: PaymentLinkReceipt,
  ): Effect.fn.Return<ResolveReceiptStep, ChainUnreachable> {
    if (!chain.validAddress(sender))
      return new InvalidAddress({ address: sender });

    if (receipt.network !== network)
      return new PaymentLinkReceiptInvalid({ reason: "wrong_network" });

    const candidates = [...new Set([receipt.balance, ...receipt.attempts])];
    const entries = yield* chain.claimable(candidates);

    const matches = selectRecoverablePaymentLinks(entries, sender).filter(
      (entry) =>
        entry.address === receipt.address &&
        assetKey(entry.asset) === assetKey(receipt.asset) &&
        entry.amount === receipt.amount,
    );

    if (matches.length === 0) return new PaymentLinkNotFound();

    if (matches.length > 1)
      return new PaymentLinkReceiptInvalid({ reason: "ambiguous" });

    const match = matches[0];

    if (!match) return new PaymentLinkNotFound();

    return new ResolvedPaymentLink({
      balance: match.balance,
      address: match.address,
      asset: match.asset,
      amount: match.amount,
    });
  });

  return { paymentLinks, resolvePaymentLink, closeGoneBalance };
});
