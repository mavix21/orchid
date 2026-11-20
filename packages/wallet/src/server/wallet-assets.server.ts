import { Transfers, pending } from "./Transfers.server";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type Approval,
  AssetOrder,
  AssetStep,
  AssetDraft,
  AssetBusy,
  AssetUnsupported,
  BalanceGone,
  InvalidAddress,
  NotClaimable,
  NotOpened,
  SenderBusy,
  TrustlineLimitReached,
  TrustlineNotEmpty,
  Unchanged,
  assetKey,
} from "../contract";
import {
  type AssetPlan,
  ClaimPlan,
  plannedSequence,
} from "../stellar/asset-plans";
import { fromStellarAsset } from "../stellar/assets";
import { maxSponsoredTrustlines, usdc } from "../stellar/network";
import {
  AssetOrders,
  AssetAuthorized,
  AssetOrderJson,
  assetPending,
} from "./AssetOrders.server";
import {
  type Applied,
  Chain,
  type Expired,
  type Rejected,
} from "./Chain.server";
import { Directory, StoreFailure } from "./Directory.server";
import { claimableAt } from "./ledger-assets.server";
import { live } from "./wallet-reads.server";

export const assetFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const orders = yield* AssetOrders;
  const directory = yield* Directory;
  const transfers = yield* Transfers;

  const reconcile = Effect.fn("Wallet.reconcileAsset")(function* (
    stored: AssetAuthorized,
  ) {
    const evidence = yield* chain.settlement(stored.sealed);

    const concluded = (decided: Applied | Rejected | Expired) =>
      orders
        .conclude(stored.order.id, decided)
        .pipe(Effect.map((done) => done.receipt));

    return yield* Match.valueTags(evidence, {
      Applied: concluded,
      Rejected: concluded,
      Expired: concluded,
      Undecided: () =>
        chain
          .submit(stored.sealed)
          .pipe(Effect.ignore, Effect.as(assetPending(stored))),
    });
  });

  const manage = Effect.fn("Wallet.manage")(function* (
    order: AssetOrder,
    approval: Option.Option<Approval>,
  ): Effect.fn.Return<
    AssetStep,
    StoreFailure | import("./Chain.server").ChainUnreachable
  > {
    if (!chain.validAddress(order.wallet))
      return new InvalidAddress({ address: order.wallet });
    const row = yield* directory.byAddress(order.wallet);

    if (Option.isNone(row) || row.value.status !== "active")
      return new NotOpened();
    const existing = yield* orders.find(order.id);

    if (Option.isSome(existing)) {
      if (
        Schema.encodeSync(AssetOrderJson)(existing.value.order) !==
        Schema.encodeSync(AssetOrderJson)(order)
      )
        return yield* new StoreFailure({
          cause: new Error("Asset order id cannot identify a different order"),
        });

      if (Predicate.isTagged(existing.value, "AssetConcluded"))
        return existing.value.receipt;

      if (Predicate.isTagged(existing.value, "AssetAuthorized"))
        return yield* reconcile(existing.value);
    }

    const paying = yield* transfers.latestFrom(order.wallet);

    if (Option.isSome(paying) && Predicate.isTagged(paying.value, "Authorized"))
      return new SenderBusy({ inFlight: pending(paying.value) });

    const held = yield* orders.inFlightFor(order.wallet);

    if (Option.isSome(held))
      return new AssetBusy({ inFlight: assetPending(held.value) });

    let plan: AssetPlan;
    const action = order.action;

    if (Predicate.isTagged(action, "ClaimBalance")) {
      const entries = yield* chain.claimable([action.balance]);
      const entry = entries[0];

      if (!entry) return new BalanceGone();

      const claimant = entry.claimants.find(
        (item) => item.destination === order.wallet,
      );

      if (
        !claimant ||
        !claimableAt(claimant.predicate, BigInt(Math.floor(Date.now() / 1000)))
      )
        return new NotClaimable({ claimableAt: Option.none() });
      plan = ClaimPlan.make({ balance: action.balance });

      if (Predicate.isTagged(entry.asset, "Issued")) {
        const state = yield* chain.holdings(order.wallet, [entry.asset]);

        if (Option.isNone(state)) return new NotOpened();

        if (!state.value.lines[0])
          plan = ClaimPlan.make({
            balance: action.balance,
            opens: entry.asset,
          });
      }
    } else {
      plan = action;
    }

    const asset = Predicate.isTagged(plan, "ClaimPlan")
      ? plan.opens
      : plan.asset;

    if (asset) {
      if (asset.issuer === order.wallet)
        return new AssetUnsupported({ reason: "self_issued" });
      const state = yield* chain.holdings(order.wallet, [asset]);

      if (Option.isNone(state)) return new NotOpened();
      const line = state.value.lines[0];

      if (Predicate.isTagged(plan, "CloseTrustline")) {
        if (assetKey(asset) === assetKey(fromStellarAsset(usdc)))
          return new AssetUnsupported({ reason: "base_asset" });

        if (!line) return new Unchanged();

        if (line.balance > 0n)
          return new TrustlineNotEmpty({ balance: line.balance });
      } else {
        if (line && Predicate.isTagged(plan, "OpenTrustline"))
          return new Unchanged();

        if (!line) {
          if (state.value.reserves.subentries >= maxSponsoredTrustlines)
            return new TrustlineLimitReached({ limit: maxSponsoredTrustlines });
          const issuer = yield* chain.issuer(asset);

          if (Option.isNone(issuer))
            return new AssetUnsupported({ reason: "issuer_missing" });

          if (issuer.value.authRequired)
            return new AssetUnsupported({ reason: "authorization_required" });
        }
      }
    }

    if (
      Option.isSome(existing) &&
      Predicate.isTagged(existing.value, "AssetProposed") &&
      live(existing.value.request)
    ) {
      const stored = existing.value;
      const state = yield* chain.account(order.wallet);
      const sequence = plannedSequence(stored.request.envelope, plan);

      if (
        Option.isSome(state) &&
        Option.isSome(sequence) &&
        BigInt(sequence.value) === BigInt(state.value.sequence) + 1n
      ) {
        if (Option.isNone(approval))
          return new AssetDraft({ request: stored.request });

        const sealed = yield* chain
          .seal(stored.request, approval.value, order.wallet)
          .pipe(Effect.option);

        if (Option.isNone(sealed))
          return new AssetDraft({ request: stored.request });
        const authorized = yield* orders.authorize(stored, sealed.value);

        return yield* Match.valueTags(authorized, {
          SlotOccupied: () =>
            Effect.succeed(new AssetDraft({ request: stored.request })),
          AssetAuthorized: reconcile,
          AssetConcluded: (concluded) => Effect.succeed(concluded.receipt),
          AssetProposed: (proposed) =>
            Effect.succeed(new AssetDraft({ request: proposed.request })),
        });
      }
    }

    const request = yield* chain.draftAsset(order.wallet, plan);

    const stored =
      Option.isSome(existing) &&
      Predicate.isTagged(existing.value, "AssetProposed")
        ? yield* orders.redraft(existing.value, request)
        : yield* orders.propose(order, request);

    return yield* Match.valueTags(stored, {
      AssetAuthorized: reconcile,
      AssetConcluded: (concluded) => Effect.succeed(concluded.receipt),
      AssetProposed: (proposed) =>
        Effect.succeed(new AssetDraft({ request: proposed.request })),
    });
  });

  return { manage, reconcile };
});
