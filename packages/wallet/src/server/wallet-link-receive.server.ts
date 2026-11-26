import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  type AccountAddress,
  type Approval,
  AssetOrder,
  type HeldFundsId,
  AssetDraft,
  type AssetPending,
  type AssetSettled,
  type AssetFailed,
  type AssetStep,
  HeldFundsGone,
  type HeldFundsGoneStatus,
  type ExternalLinkFailed,
  type ExternalLinkPending,
  type ExternalLinkSettled,
  InvalidAddress,
  LinkUnclaimable,
  NotClaimable,
  NotOpened,
  PaymentLinkChecking,
  PaymentLinkNotFound,
  PaymentLinkOpen,
  type PaymentLinkStep,
  PaymentLinkUnrecognized,
  PaymentLinkUnresolved,
  PaymentLinkUsed,
  type ReceiveLink,
  RecipientCannotReceive,
  type SigningRequest,
  sameAsset,
  baseAsset,
  needsTrustline,
} from "../contract";
import {
  type AssetAuthorized,
  type AssetConcluded,
  AssetOrders,
  type ConcludedReceipt,
  type StoredAssetOrder,
} from "./AssetOrders.server";
import {
  Chain,
  type ChainUnreachable,
  DraftPurpose,
  type LinkReceive,
} from "./Chain.server";
import { StoreFailure } from "./Directory.server";
import { selectRecoverablePaymentLinks } from "./ledger-assets.server";
import { type FundedLink, Transfers } from "./Transfers.server";
import { externalLinkClaimFlow } from "./wallet-link-external.server";
import { live } from "./wallet-reads.server";

type ReconciledStep =
  | AssetPending
  | AssetSettled
  | AssetFailed
  | ExternalLinkPending
  | ExternalLinkSettled
  | ExternalLinkFailed;

type Reconcile = (
  stored: AssetAuthorized,
) => Effect.Effect<ReconciledStep, StoreFailure | ChainUnreachable>;

const receiving = (stored: StoredAssetOrder) =>
  Predicate.isTagged(stored.order.action, "ReceiveLink") ||
  Predicate.isTagged(stored.order.action, "ReceiveLinkExternal");

const settledHere = (stored: StoredAssetOrder) =>
  Predicate.isTagged(stored, "AssetConcluded") &&
  (Predicate.isTagged(stored.receipt, "AssetSettled") ||
    Predicate.isTagged(stored.receipt, "ExternalLinkSettled"));

const walletReceipt = (
  receipt: ConcludedReceipt,
): Effect.Effect<AssetSettled | AssetFailed, StoreFailure> =>
  Predicate.isTagged(receipt, "AssetSettled") ||
  Predicate.isTagged(receipt, "AssetFailed")
    ? Effect.succeed(receipt)
    : Effect.fail(
        new StoreFailure({
          cause: new Error("Wallet link receive produced an external receipt"),
        }),
      );

const walletStep = (
  step: ReconciledStep,
): Effect.Effect<AssetPending | AssetSettled | AssetFailed, StoreFailure> =>
  Predicate.isTagged(step, "AssetPending") ||
  Predicate.isTagged(step, "AssetSettled") ||
  Predicate.isTagged(step, "AssetFailed")
    ? Effect.succeed(step)
    : Effect.fail(
        new StoreFailure({
          cause: new Error("Wallet link receive produced an external step"),
        }),
      );

export const linkReceiveFlow = (reconcile: Reconcile) =>
  Effect.gen(function* () {
    const chain = yield* Chain;
    const orders = yield* AssetOrders;
    const transfers = yield* Transfers;

    const liveLink = Effect.fn("Wallet.liveLink")(function* (
      link: AccountAddress,
      funded: FundedLink,
    ) {
      const entries = yield* chain.heldFunds([funded.heldFunds]);

      const matched = selectRecoverablePaymentLinks(
        entries,
        funded.sender.address,
      ).some(
        (entry) =>
          entry.heldFunds === funded.heldFunds &&
          entry.address === link &&
          sameAsset(entry.asset, funded.asset) &&
          entry.amount === funded.amount,
      );

      return { matched, present: entries.length > 0 };
    });

    const cleanUp = Effect.fn("Wallet.cleanUpReceivedLink")(function* (
      concluded: AssetConcluded,
    ) {
      const { action } = concluded.order;

      if (
        (!Predicate.isTagged(action, "ReceiveLink") &&
          !Predicate.isTagged(action, "ReceiveLinkExternal")) ||
        (!Predicate.isTagged(concluded.receipt, "AssetSettled") &&
          !Predicate.isTagged(concluded.receipt, "ExternalLinkSettled"))
      )
        return true;

      const gone = yield* chain.cleanUpLink(action.link);

      if (gone) yield* orders.linkCleaned(concluded.order.id);

      return gone;
    });

    const settled = (
      stored: AssetAuthorized,
    ): Effect.Effect<ReconciledStep, StoreFailure | ChainUnreachable> =>
      reconcile(stored).pipe(
        Effect.tap((receipt) =>
          (Predicate.isTagged(receipt, "AssetSettled") ||
            Predicate.isTagged(receipt, "ExternalLinkSettled")) &&
          receiving(stored)
            ? orders
                .find(stored.order.id)
                .pipe(
                  Effect.flatMap((found) =>
                    Option.isSome(found) &&
                    Predicate.isTagged(found.value, "AssetConcluded")
                      ? cleanUp(found.value).pipe(Effect.ignore)
                      : Effect.void,
                  ),
                )
            : Effect.void,
        ),
      );

    const goneStatus = (
      stored: ReadonlyArray<StoredAssetOrder>,
      claimer: Option.Option<AccountAddress>,
    ): HeldFundsGoneStatus => {
      const claims = stored
        .filter(settledHere)
        .filter((entry) => !receiving(entry));

      if (
        claims.some((entry) =>
          Option.match(claimer, {
            onNone: () => true,
            onSome: (wallet) =>
              entry.order instanceof AssetOrder &&
              entry.order.wallet === wallet,
          }),
        )
      )
        return "reclaimed";

      return stored.some(settledHere) ? "claimed" : "unresolved";
    };

    const settleOnHeldFunds = Effect.fn("Wallet.settleOnHeldFunds")(function* (
      heldFunds: HeldFundsId,
    ) {
      const recorded = yield* orders.onHeldFunds(heldFunds);

      const authorized = recorded.filter((stored): stored is AssetAuthorized =>
        Predicate.isTagged(stored, "AssetAuthorized"),
      );

      const receivePending = yield* Effect.forEach(authorized, (stored) =>
        Effect.map(
          settled(stored),
          (receipt) =>
            receiving(stored) &&
            (Predicate.isTagged(receipt, "AssetPending") ||
              Predicate.isTagged(receipt, "ExternalLinkPending")),
        ),
      );

      return {
        checking: receivePending.some(Boolean),
        current:
          authorized.length === 0
            ? recorded
            : yield* orders.onHeldFunds(heldFunds),
      };
    });

    const heldFundsGone = (
      heldFunds: HeldFundsId,
      claimer: Option.Option<AccountAddress> = Option.none(),
    ) =>
      Effect.map(
        settleOnHeldFunds(heldFunds),
        ({ current }) =>
          new HeldFundsGone({ status: goneStatus(current, claimer) }),
      );

    const paymentLink = Effect.fn("Wallet.paymentLink")(function* (
      link: AccountAddress,
    ): Effect.fn.Return<PaymentLinkStep, StoreFailure | ChainUnreachable> {
      if (!chain.validAddress(link))
        return new InvalidAddress({ address: link });

      const funded = yield* transfers.fundedLink(link);

      if (Option.isNone(funded)) return new PaymentLinkNotFound();

      const { checking, current } = yield* settleOnHeldFunds(
        funded.value.heldFunds,
      );

      if (checking) return new PaymentLinkChecking();

      const { matched, present } = yield* liveLink(link, funded.value);

      if (matched)
        return new PaymentLinkOpen({
          heldFunds: funded.value.heldFunds,
          asset: funded.value.asset,
          amount: funded.value.amount,
          sender: funded.value.sender,
        });

      if (present) return new PaymentLinkUnrecognized();

      yield* Effect.forEach(
        current.filter(
          (stored): stored is AssetConcluded =>
            Predicate.isTagged(stored, "AssetConcluded") &&
            receiving(stored) &&
            settledHere(stored),
        ),
        (stored) => cleanUp(stored).pipe(Effect.ignore),
        { discard: true },
      );

      return goneStatus(current, Option.none()) === "unresolved"
        ? new PaymentLinkUnresolved()
        : new PaymentLinkUsed();
    });

    const receive = Effect.fn("Wallet.receiveLink")(function* (
      order: AssetOrder,
      action: typeof ReceiveLink.Type,
      approval: Option.Option<Approval>,
      existing: Option.Option<StoredAssetOrder>,
      walletOpening: boolean,
    ): Effect.fn.Return<AssetStep, StoreFailure | ChainUnreachable> {
      if (!chain.validAddress(action.link))
        return new InvalidAddress({ address: action.link });

      const funded = yield* transfers.fundedLink(action.link);

      if (Option.isNone(funded) || funded.value.heldFunds !== action.heldFunds)
        return new NotClaimable({ claimableAt: Option.none() });

      const { matched, present } = yield* liveLink(action.link, funded.value);

      if (!matched)
        return present
          ? new NotClaimable({ claimableAt: Option.none() })
          : yield* heldFundsGone(action.heldFunds);

      const { asset, amount } = funded.value;

      if (order.wallet === action.link)
        return new LinkUnclaimable({ reason: "destination_is_link" });

      if (chain.issuedBy(asset, order.wallet))
        return new LinkUnclaimable({ reason: "destination_is_issuer" });

      const blocker = yield* chain.receiveBlocker(order.wallet, asset, amount);

      const openedByOpening =
        walletOpening &&
        (!needsTrustline(asset) || sameAsset(asset, baseAsset));

      if (Option.isSome(blocker)) {
        if (blocker.value !== "no_account")
          return new RecipientCannotReceive({
            address: order.wallet,
            reason: blocker.value,
          });

        if (!openedByOpening) return new NotOpened();
      }

      const terms: LinkReceive = {
        link: action.link,
        destination: order.wallet,
        heldFunds: action.heldFunds,
        asset,
        amount,
      };

      const prepared = yield* chain.prepareLinkReceive(terms);

      if (prepared instanceof LinkUnclaimable) return prepared;

      const current = (request: SigningRequest) =>
        chain.draftCurrent(
          request,
          DraftPurpose.LinkReceive({ receive: prepared }),
        );

      const proposed = Option.filter(existing, (stored) =>
        Predicate.isTagged(stored, "AssetProposed"),
      );

      if (
        Option.isSome(proposed) &&
        Predicate.isTagged(proposed.value, "AssetProposed") &&
        (yield* live(proposed.value.request)) &&
        (yield* current(proposed.value.request))
      ) {
        const stored = proposed.value;

        if (Option.isNone(approval))
          return new AssetDraft({ request: stored.request });

        const sealed = yield* chain
          .seal(stored.request, approval.value, action.link)
          .pipe(Effect.option);

        if (Option.isNone(sealed) || !(yield* current(stored.request)))
          return new AssetDraft({ request: stored.request });

        const authorized = yield* orders.authorize(stored, sealed.value);

        return yield* Match.valueTags(authorized, {
          SlotOccupied: () =>
            Effect.succeed(new AssetDraft({ request: stored.request })),
          WalletInactive: () => Effect.succeed(new NotOpened()),
          AssetAuthorized: (entry) =>
            settled(entry).pipe(Effect.flatMap(walletStep)),
          AssetConcluded: (concluded) => walletReceipt(concluded.receipt),
          AssetProposed: (next) =>
            Effect.succeed(new AssetDraft({ request: next.request })),
        });
      }

      const request = yield* chain.draftLinkReceive(prepared);

      const stored =
        Option.isSome(proposed) &&
        Predicate.isTagged(proposed.value, "AssetProposed")
          ? yield* orders.redraft(proposed.value, request)
          : yield* orders.propose(order, request);

      return yield* Match.valueTags(stored, {
        AssetAuthorized: (entry) =>
          settled(entry).pipe(Effect.flatMap(walletStep)),
        AssetConcluded: (concluded) => walletReceipt(concluded.receipt),
        AssetProposed: (next) =>
          Effect.succeed(new AssetDraft({ request: next.request })),
      });
    });

    const claimExternal = yield* externalLinkClaimFlow({
      liveLink,
      settleOnHeldFunds,
      heldFundsGone,
      settled,
    });

    return {
      receive,
      claimExternal,
      paymentLink,
      settled,
      heldFundsGone,
      cleanUpReceived: cleanUp,
    };
  });
