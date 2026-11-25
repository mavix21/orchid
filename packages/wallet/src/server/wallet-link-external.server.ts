import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  type Approval,
  type BalanceGone,
  type BalanceId,
  ExternalLinkDraft,
  type ExternalLinkFailed,
  type ExternalLinkOrder,
  type ExternalLinkPending,
  type ExternalLinkSettled,
  type ExternalLinkStep,
  ExternalMemoRequired,
  InvalidAddress,
  LinkUnclaimable,
  MemoNotAllowed,
  NotClaimable,
  PaymentLinkChecking,
  RecipientCannotReceive,
  type SigningRequest,
  assetKey,
} from "../contract";
import { baseAccountOf, isMuxed } from "../stellar/destination";
import { readEnvelope } from "../stellar/envelopes";
import { sameMemo } from "../stellar/memo";
import {
  type AssetAuthorized,
  AssetOrders,
  type ConcludedReceipt,
  type StoredAssetOrder,
  StoredOrderJson,
  toStoredExternalOrder,
} from "./AssetOrders.server";
import { Chain, type ChainUnreachable } from "./Chain.server";
import { StoreFailure } from "./Directory.server";
import { type FundedLink, Transfers } from "./Transfers.server";
import { live } from "./wallet-reads.server";

export type OrderReceipt =
  | ExternalLinkPending
  | ExternalLinkSettled
  | ExternalLinkFailed;

export type LinkAccountPlan = "Create" | "Reuse" | "Refuse";

export interface LinkReceiveShared {
  readonly linkAccountPlan: (
    link: AccountAddress,
  ) => Effect.Effect<LinkAccountPlan, ChainUnreachable>;
  readonly liveLink: (
    link: AccountAddress,
    funded: FundedLink,
  ) => Effect.Effect<
    { readonly matched: boolean; readonly present: boolean },
    ChainUnreachable
  >;
  readonly settleOnBalance: (balance: BalanceId) => Effect.Effect<
    {
      readonly checking: boolean;
      readonly current: ReadonlyArray<StoredAssetOrder>;
    },
    StoreFailure | ChainUnreachable
  >;
  readonly balanceGone: (
    balance: BalanceId,
  ) => Effect.Effect<BalanceGone, StoreFailure | ChainUnreachable>;
  readonly settled: (
    stored: AssetAuthorized,
  ) => Effect.Effect<
    | OrderReceipt
    | import("../contract").AssetPending
    | import("../contract").AssetSettled
    | import("../contract").AssetFailed,
    StoreFailure | ChainUnreachable
  >;
}

const externalReceipt = (
  receipt: ConcludedReceipt,
): Effect.Effect<ExternalLinkSettled | ExternalLinkFailed, StoreFailure> =>
  Predicate.isTagged(receipt, "ExternalLinkSettled") ||
  Predicate.isTagged(receipt, "ExternalLinkFailed")
    ? Effect.succeed(receipt)
    : Effect.fail(
        new StoreFailure({
          cause: new Error("External link order produced a wallet receipt"),
        }),
      );

const externalStep = (
  receipt:
    | OrderReceipt
    | import("../contract").AssetPending
    | import("../contract").AssetSettled
    | import("../contract").AssetFailed,
): Effect.Effect<OrderReceipt, StoreFailure> =>
  Predicate.isTagged(receipt, "ExternalLinkPending") ||
  Predicate.isTagged(receipt, "ExternalLinkSettled") ||
  Predicate.isTagged(receipt, "ExternalLinkFailed")
    ? Effect.succeed(receipt)
    : Effect.fail(
        new StoreFailure({
          cause: new Error("External link order produced a wallet step"),
        }),
      );

export const externalLinkClaimFlow = (shared: LinkReceiveShared) =>
  Effect.gen(function* () {
    const chain = yield* Chain;
    const orders = yield* AssetOrders;
    const transfers = yield* Transfers;

    const reconcileExternal = (stored: AssetAuthorized) =>
      shared.settled(stored).pipe(Effect.flatMap(externalStep));

    const currentExternalReceive = Effect.fn("Wallet.currentExternalReceive")(
      function* (
        request: SigningRequest,
        order: ExternalLinkOrder,
        funded: FundedLink,
        createsLinkAccount: boolean,
      ) {
        const facts = readEnvelope(request.envelope);

        if (
          Option.isNone(facts) ||
          !Predicate.isTagged(facts.value, "LinkReceiveFacts")
        )
          return false;

        const channel = yield* chain.account(facts.value.channel);

        return (
          Option.isSome(channel) &&
          facts.value.link === order.link &&
          facts.value.balance === order.balance &&
          facts.value.destination === order.destination &&
          sameMemo(facts.value.memo, order.memo) &&
          facts.value.createsLinkAccount === createsLinkAccount &&
          assetKey(facts.value.asset) === assetKey(funded.asset) &&
          facts.value.amount === funded.amount &&
          BigInt(channel.value.sequence) + 1n === BigInt(facts.value.sequence)
        );
      },
    );

    return Effect.fn("Wallet.claimPaymentLink")(function* (
      order: ExternalLinkOrder,
      approval: Option.Option<Approval>,
    ): Effect.fn.Return<ExternalLinkStep, StoreFailure | ChainUnreachable> {
      if (!chain.validAddress(order.link))
        return new InvalidAddress({ address: order.link });

      if (!chain.validAddress(order.destination))
        return new InvalidAddress({ address: order.destination });

      const storedOrder = toStoredExternalOrder(order);
      const existing = yield* orders.find(order.id);

      if (Option.isSome(existing)) {
        if (
          Schema.encodeSync(StoredOrderJson)(existing.value.order) !==
          Schema.encodeSync(StoredOrderJson)(storedOrder)
        )
          return yield* new StoreFailure({
            cause: new Error(
              "Asset order id cannot identify a different order",
            ),
          });

        if (Predicate.isTagged(existing.value, "AssetConcluded"))
          return yield* externalReceipt(existing.value.receipt);

        if (Predicate.isTagged(existing.value, "AssetAuthorized"))
          return yield* reconcileExternal(existing.value);
      }

      const funded = yield* transfers.fundedLink(order.link);

      if (Option.isNone(funded) || funded.value.balance !== order.balance)
        return new NotClaimable({ claimableAt: Option.none() });

      const { checking } = yield* shared.settleOnBalance(order.balance);

      if (checking) return new PaymentLinkChecking();

      const { matched, present } = yield* shared.liveLink(
        order.link,
        funded.value,
      );

      if (!matched)
        return present
          ? new NotClaimable({ claimableAt: Option.none() })
          : yield* shared.balanceGone(order.balance);

      const { asset, amount } = funded.value;
      const baseDestination = baseAccountOf(order.destination);

      if (baseDestination === order.link)
        return new LinkUnclaimable({ reason: "destination_is_link" });

      if (
        Predicate.isTagged(asset, "Issued") &&
        asset.issuer === baseDestination
      )
        return new LinkUnclaimable({ reason: "destination_is_issuer" });

      let memoRequired = false;

      if (isMuxed(order.destination)) {
        if (order.memo !== undefined)
          return new MemoNotAllowed({ reason: "muxed" });
      } else {
        const requirement = yield* chain.memoRequiredFor(baseDestination);

        if (Option.isSome(requirement) && order.memo === undefined)
          return new ExternalMemoRequired({
            address: baseDestination,
            exchange: requirement.value.exchange,
            source: requirement.value.source,
          });

        memoRequired = Option.isSome(requirement);
      }

      const holdings = yield* chain.holdings(
        baseDestination,
        Predicate.isTagged(asset, "Issued") ? [asset] : [],
      );

      if (Option.isNone(holdings))
        return new RecipientCannotReceive({
          address: baseDestination,
          reason: "no_account",
        });

      if (Predicate.isTagged(asset, "Issued")) {
        const line = holdings.value.lines.find(
          (candidate) => assetKey(candidate.asset) === assetKey(asset),
        );

        const reason =
          line === undefined
            ? "no_trustline"
            : !line.authorized
              ? "not_authorized"
              : line.capacity < amount
                ? "no_capacity"
                : undefined;

        if (reason !== undefined)
          return new RecipientCannotReceive({
            address: baseDestination,
            reason,
          });
      }

      const plan = yield* shared.linkAccountPlan(order.link);

      if (plan === "Refuse")
        return new LinkUnclaimable({ reason: "link_account_unexpected" });

      const createsLinkAccount = plan === "Create";

      const proposed = Option.filter(existing, (stored) =>
        Predicate.isTagged(stored, "AssetProposed"),
      );

      if (
        Option.isSome(proposed) &&
        Predicate.isTagged(proposed.value, "AssetProposed") &&
        (yield* live(proposed.value.request)) &&
        (yield* currentExternalReceive(
          proposed.value.request,
          order,
          funded.value,
          createsLinkAccount,
        ))
      ) {
        const stored = proposed.value;

        if (Option.isNone(approval))
          return new ExternalLinkDraft({
            request: stored.request,
            memoRequired,
          });

        const sealed = yield* chain
          .seal(stored.request, approval.value, order.link)
          .pipe(Effect.option);

        if (
          Option.isNone(sealed) ||
          !(yield* currentExternalReceive(
            stored.request,
            order,
            funded.value,
            createsLinkAccount,
          ))
        )
          return new ExternalLinkDraft({
            request: stored.request,
            memoRequired,
          });

        const authorized = yield* orders.authorizeExternal(
          stored,
          sealed.value,
        );

        return yield* Match.valueTags(authorized, {
          SlotOccupied: () => Effect.succeed(new PaymentLinkChecking()),
          AssetAuthorized: reconcileExternal,
          AssetConcluded: (concluded) => externalReceipt(concluded.receipt),
          AssetProposed: (next) =>
            Effect.succeed(
              new ExternalLinkDraft({ request: next.request, memoRequired }),
            ),
        });
      }

      const request = yield* chain.draftLinkReceive(
        order.link,
        createsLinkAccount,
        order.destination,
        order.balance,
        asset,
        amount,
        order.memo,
      );

      const stored =
        Option.isSome(proposed) &&
        Predicate.isTagged(proposed.value, "AssetProposed")
          ? yield* orders.redraft(proposed.value, request)
          : yield* orders.propose(storedOrder, request);

      return yield* Match.valueTags(stored, {
        AssetAuthorized: reconcileExternal,
        AssetConcluded: (concluded) => externalReceipt(concluded.receipt),
        AssetProposed: (next) =>
          Effect.succeed(
            new ExternalLinkDraft({ request: next.request, memoRequired }),
          ),
      });
    });
  });
