import { Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type Approval,
  AssetOrder,
  AssetOrderId,
  ClaimBalance,
  LinkSecret,
  PaymentLinkNotFound,
  PaymentLinkRecipient,
  type Pending,
  type WalletPort,
  type WalletUnavailable,
  assetKey,
} from "../contract";
import { readEnvelope } from "../stellar/envelopes";
import { approvalMargin, network, paymentLifetime } from "../stellar/network";
import {
  type KeyStore,
  type KeyStoreUnavailable,
  clearStoredLink,
} from "./key-store";
import {
  ApprovalOutstanding,
  type CancelPaymentLinkOutcome,
  type CreatePaymentLinkOutcome,
  DraftRejected,
  NoWallet,
  PaymentLinkCreated,
  type PaymentLinkIntent,
  type PaymentLinkTarget,
  type PaymentLinksOutcome,
  type ResolvePaymentLinkOutcome,
  TransferIntent,
  UnsupportedDevice,
} from "./outcomes";
import { pendingSteps, pollSchedule } from "./polling";
import { sendTransfer } from "./sending";
import { approve, signingKey } from "./signing";

const clockAllowance = 60;

const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

interface CancelTurn {
  readonly done: Option.Option<CancelPaymentLinkOutcome>;
  readonly pause: boolean;
}

export function devicePaymentLinks(port: WalletPort, store: KeyStore) {
  const transfers = sendTransfer(port, store);

  const createPaymentLink = Effect.fn("Device.createPaymentLink")(function* (
    intent: PaymentLinkIntent,
  ): Effect.fn.Return<
    CreatePaymentLinkOutcome,
    WalletUnavailable | KeyStoreUnavailable
  > {
    const generated = Keypair.random();
    const address = Schema.decodeSync(AccountAddress)(generated.publicKey());
    const secret = Schema.decodeSync(LinkSecret)(generated.secret());

    const outcome = yield* transfers.send(
      new TransferIntent({
        to: PaymentLinkRecipient.make({ value: address }),
        asset: intent.asset,
        amount: intent.amount,
      }),
    );

    if (!Predicate.isTagged(outcome, "Settled")) return outcome;

    if (outcome.claimable === undefined) return new DraftRejected();

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

  const cancelPaymentLink = Effect.fn("Device.cancelPaymentLink")(function* (
    target: PaymentLinkTarget,
  ): Effect.fn.Return<
    CancelPaymentLinkOutcome,
    WalletUnavailable | KeyStoreUnavailable
  > {
    const stored = yield* store.readPublic();

    if (Option.isNone(stored)) return new NoWallet();

    const wallet = stored.value;
    const { balance, asset } = target;

    const order = new AssetOrder({
      id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
      wallet: wallet.address,
      action: ClaimBalance.make({ balance }),
    });

    let approval: Option.Option<Approval> = Option.none();
    let signed = false;
    let refreshed = false;
    let attempts = 0;

    const step: Effect.Effect<
      CancelTurn,
      WalletUnavailable | KeyStoreUnavailable
    > = Effect.gen(function* () {
      const submitted = Option.isSome(approval);

      attempts++;

      const response = yield* port.manage(order, approval);

      approval = Option.none();

      return yield* Match.valueTags(response, {
        AssetDraft: (draft) =>
          Effect.gen(function* () {
            const facts = readEnvelope(draft.request.envelope);
            const now = yield* nowSeconds;

            const validOpens =
              Option.isSome(facts) &&
              Predicate.isTagged(facts.value, "ClaimFacts") &&
              (facts.value.opens === undefined
                ? facts.value.reserveSponsor === undefined
                : Predicate.isTagged(asset, "Issued") &&
                  assetKey(facts.value.opens) === assetKey(asset) &&
                  wallet.reserveSponsor !== undefined &&
                  facts.value.reserveSponsor === wallet.reserveSponsor);

            if (
              attempts >= pendingSteps ||
              signed ||
              Option.isNone(facts) ||
              !Predicate.isTagged(facts.value, "ClaimFacts") ||
              facts.value.address !== wallet.address ||
              facts.value.balance !== balance ||
              !validOpens ||
              facts.value.maxTime > now + paymentLifetime + clockAllowance
            )
              return { done: Option.some(new DraftRejected()), pause: false };

            const deadline = Math.min(
              facts.value.maxTime * 1000,
              DateTime.toEpochMillis(draft.request.expiresAt),
            );

            const withinMargin = Effect.map(
              DateTime.now,
              (current) =>
                deadline - DateTime.toEpochMillis(current) >=
                approvalMargin * 1000,
            );

            const refreshOrReject = (): CancelTurn => {
              if (refreshed)
                return { done: Option.some(new DraftRejected()), pause: false };

              refreshed = true;

              return { done: Option.none(), pause: false };
            };

            if (!(yield* withinMargin)) return refreshOrReject();

            const secret = yield* store.read();

            if (
              Option.isNone(secret) ||
              secret.value.address !== wallet.address
            )
              return {
                done: Option.some(new UnsupportedDevice()),
                pause: false,
              };

            if (!(yield* withinMargin)) return refreshOrReject();

            signed = true;
            approval = Option.some(
              approve(draft.request, signingKey(secret.value.phrase)),
            );

            return { done: Option.none(), pause: false };
          }),
        AssetPending: (pending) =>
          Effect.succeed<CancelTurn>({
            done:
              attempts >= pendingSteps ? Option.some(pending) : Option.none(),
            pause: !submitted,
          }),
        AssetSettled: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        AssetFailed: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        NotOpened: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        InvalidAddress: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        SenderBusy: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        AssetBusy: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        Unchanged: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        TrustlineLimitReached: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        TrustlineNotEmpty: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        AssetUnsupported: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        RecipientCannotReceive: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        NotClaimable: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        BalanceGone: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
      });
    });

    const last = yield* Effect.repeat(step, {
      schedule: pollSchedule<CancelTurn>(
        (turn) => Option.isNone(turn.done),
        (turn) => turn.pause,
      ),
    });

    return Option.getOrElse(last.done, () => new DraftRejected());
  });

  return {
    createPaymentLink,
    paymentLinks,
    resolvePaymentLink,
    cancelPaymentLink,
  };
}
