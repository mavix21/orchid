import { Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  LinkSecret,
  PaymentLinkNotFound,
  PaymentLinkRecipient,
  type Pending,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import { network } from "../stellar/network";
import {
  type CorruptDeviceWallet,
  type KeyStore,
  type KeyStoreUnavailable,
  clearStoredLink,
} from "./key-store";
import {
  ApprovalOutstanding,
  type ConfirmPaymentLinkOutcome,
  DraftRejected,
  NoWallet,
  PaymentLinkCreated,
  type PaymentLinkIntent,
  type PaymentLinksOutcome,
  type PaymentReview,
  type ResolvePaymentLinkOutcome,
  type ReviewPaymentLinkOutcome,
  TransferIntent,
} from "./outcomes";
import { type Reviews, sendTransfer } from "./sending";

const clockAllowance = 60;

const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

export interface HeldLink {
  readonly address: AccountAddress;
  readonly secret: LinkSecret;
}

export function devicePaymentLinks(
  port: WalletPort,
  store: KeyStore,
  reviews: Reviews,
  held: Ref.Ref<Option.Option<HeldLink>>,
) {
  const transfers = sendTransfer(port, store, reviews);

  const review = Effect.fn("Device.reviewPaymentLink")(function* (
    intent: PaymentLinkIntent,
  ): Effect.fn.Return<
    ReviewPaymentLinkOutcome,
    WalletUnavailable | KeyStoreUnavailable
  > {
    const generated = Keypair.random();
    const address = Schema.decodeSync(AccountAddress)(generated.publicKey());
    const secret = Schema.decodeSync(LinkSecret)(generated.secret());

    const reviewed = yield* transfers.reviewLinkFunding(
      new TransferIntent({
        to: PaymentLinkRecipient.make({ value: address }),
        asset: intent.asset,
        amount: intent.amount,
      }),
    );

    if (Predicate.isTagged(reviewed, "Settled")) return new DraftRejected();

    if (Predicate.isTagged(reviewed, "PaymentReview"))
      yield* Ref.set(held, Option.some({ address, secret }));

    return reviewed;
  });

  const confirm = Effect.fn("Device.confirmPaymentLink")(function* (
    shown: PaymentReview,
  ): Effect.fn.Return<
    ConfirmPaymentLinkOutcome,
    WalletUnavailable | KeyStoreUnavailable | CorruptDeviceWallet
  > {
    const link = Option.filter(
      yield* Ref.get(held),
      ({ address }) =>
        Predicate.isTagged(shown.order.to, "PaymentLink") &&
        shown.order.to.value === address,
    );

    if (Option.isNone(link)) return new DraftRejected();

    const outcome = yield* transfers.confirmLinkFunding(shown);

    if (!Predicate.isTagged(outcome, "Settled")) return outcome;

    if (outcome.claimable === undefined) return new DraftRejected();

    const { address, secret } = link.value;

    yield* Ref.update(held, (current) =>
      Option.exists(current, (kept) => kept.address === address)
        ? Option.none()
        : current,
    );

    return new PaymentLinkCreated({
      id: outcome.id,
      address,
      secret,
      balance: outcome.claimable,
      asset: outcome.asset,
      amount: outcome.amount,
      network,
      path: `/l/${address}#${secret}`,
      settledAt: outcome.settledAt,
    });
  });

  const paymentLinks = Effect.fn("Device.paymentLinks")(
    function* (): Effect.fn.Return<
      PaymentLinksOutcome,
      WalletUnavailable | KeyStoreUnavailable
    > {
      const stored = yield* store.readPublic();

      if (Option.isNone(stored)) return new NoWallet();

      return yield* port.paymentLinks(stored.value.address);
    },
  );

  const resolvePaymentLink = Effect.fn("Device.resolvePaymentLink")(
    function* (): Effect.fn.Return<
      ResolvePaymentLinkOutcome,
      WalletUnavailable | KeyStoreUnavailable
    > {
      const stored = yield* store.readPublic();

      if (Option.isNone(stored)) return new NoWallet();

      const wallet = stored.value;
      const receipt = wallet.linkReceipt;

      if (receipt === undefined) return new PaymentLinkNotFound();

      const clearTarget = {
        address: wallet.address,
        transferId: wallet.transfer?.id,
        approvedUntil: wallet.approvedUntil,
        receipt,
      };

      let concluded = false;
      let pendingStatus: Pending | undefined;

      if (
        wallet.transfer !== undefined &&
        Predicate.isTagged(wallet.transfer.to, "PaymentLink") &&
        wallet.approvedUntil !== undefined
      ) {
        const status = yield* port.transfer(wallet.transfer, Option.none());

        if (Predicate.isTagged(status, "Pending")) pendingStatus = status;

        concluded =
          Predicate.isTagged(status, "Settled") ||
          Predicate.isTagged(status, "Failed");
      }

      const resolved = yield* port.resolvePaymentLink(wallet.address, receipt);

      if (Predicate.isTagged(resolved, "ResolvedPaymentLink")) {
        yield* clearStoredLink(store, clearTarget);

        return resolved;
      }

      if (Predicate.isTagged(resolved, "PaymentLinkNotFound")) {
        if (pendingStatus !== undefined) return pendingStatus;

        const now = yield* nowSeconds;

        if (
          !concluded &&
          wallet.transfer !== undefined &&
          wallet.approvedUntil !== undefined &&
          wallet.approvedUntil + clockAllowance >= now
        )
          return new ApprovalOutstanding({ order: wallet.transfer });

        yield* clearStoredLink(store, clearTarget);
      }

      return resolved;
    },
  );

  return {
    review,
    confirm,
    paymentLinks,
    resolvePaymentLink,
  };
}
