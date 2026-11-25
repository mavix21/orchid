import { portfolioFlow } from "./wallet-portfolio.server";
import {
  deliveryFlow,
  paymentLinkAssetRefusal,
} from "./wallet-delivery.server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  DestinationAddress,
  SigningRequest,
  AssetBusy,
  ClaimableLimitReached,
  Amount,
  assetKey,
  Approval,
  ExternalRecipient,
  Holding,
  InvalidAddress,
  LinkRecipient,
  MemoNotAllowed,
  ExternalMemoRequired,
  InsufficientBalance,
  NeedsReopening,
  NotOpened,
  Overview,
  PhoneNotSupported,
  Receipt,
  ResolvedRecipient,
  SenderBusy,
  TransferDraft,
  TransferOrder,
  TransferStep,
  UnknownRecipient,
  type WalletPort,
  type ServerFailure,
} from "../contract";
import { baseAccountOf, isMuxed } from "../stellar/destination";
import { readEnvelope } from "../stellar/envelopes";
import { Chain, ChainUnreachable, type Sealed } from "./Chain.server";
import type { KnownExchangeMemo } from "./exchange-memos.server";
import { memoRefusal } from "./memo-refusal.server";
import { Directory, StoreFailure } from "./Directory.server";
import {
  Authorized,
  type Concluded,
  OrderJson,
  Proposed,
  type Transfer,
  Transfers,
} from "./Transfers.server";
import { AssetOrders, assetPending } from "./AssetOrders.server";
import { assetFlow } from "./wallet-assets.server";
import { openingFlow } from "./wallet-opening.server";
import { Backups } from "./Backups.server";
import { HumanCheck } from "./HumanCheck.server";
import { concealFailure } from "./failures.server";
import { backupFlow } from "./wallet-backup.server";
import { activityFlow } from "./wallet-activity.server";
import { paymentLinksFlow } from "./wallet-payment-links.server";
import { confirmedReads, live } from "./wallet-reads.server";
import { claimableQuotaFlow } from "./claimable-quota.server";
import { transferReconcileFlow } from "./wallet-reconcile.server";
import type { PendingWork, WorkAttended } from "./work-queue.server";
import { sweepFlow } from "./wallet-sweep.server";
import { workFlow } from "./wallet-work.server";

export class Wallet extends Context.Service<
  Wallet,
  WalletPort<ServerFailure> & {
    readonly sweep: Effect.Effect<void, ServerFailure>;
    attend(
      work: PendingWork,
      attempt: number,
    ): Effect.Effect<WorkAttended, ServerFailure>;
  }
>()("@workspace/wallet/server/Wallet") {
  static readonly serviceLayer = Layer.effect(
    Wallet,
    Effect.gen(function* () {
      const chain = yield* Chain;
      const directory = yield* Directory;
      const transfers = yield* Transfers;
      const assets = yield* AssetOrders;
      const reconcile = yield* transferReconcileFlow;
      const assetActions = yield* assetFlow;
      const delivery = yield* deliveryFlow;
      const checkLinkAsset = yield* paymentLinkAssetRefusal;
      const { quotaFull } = yield* claimableQuotaFlow;
      const links = yield* paymentLinksFlow;
      const history = yield* activityFlow;
      const portfolio = yield* portfolioFlow;

      const wrap = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(Effect.catchCause(concealFailure));

      const { readBalance } = yield* confirmedReads;
      const { open } = yield* openingFlow;
      const backup = yield* backupFlow;

      const memoRequirement = Effect.fn("Wallet.memoRequirement")(function* (
        recipient: ResolvedRecipient,
      ) {
        return recipient instanceof ExternalRecipient &&
          !isMuxed(recipient.address)
          ? yield* chain.memoRequiredFor(baseAccountOf(recipient.address))
          : Option.none<KnownExchangeMemo>();
      });

      const proposedStep = (
        proposed: Proposed,
        requirement: Option.Option<KnownExchangeMemo>,
      ): TransferDraft | ExternalMemoRequired | MemoNotAllowed => {
        const refusal = memoRefusal(
          proposed.order,
          proposed.recipient,
          requirement,
        );

        if (Option.isSome(refusal)) return refusal.value;

        return new TransferDraft({
          request: proposed.request,
          recipient: proposed.recipient,
          memoRequired: Option.isSome(requirement),
          claimable: proposed.claimable,
        });
      };

      const signedStep = (signed: Authorized | Concluded) =>
        Match.valueTags(signed, {
          Concluded: (concluded) => Effect.succeed(concluded.receipt),
          Authorized: reconcile,
        });

      const resumed = Effect.fn("Wallet.resumed")(function* (
        transfer: Transfer,
        requirement: Option.Option<KnownExchangeMemo>,
      ): Effect.fn.Return<TransferStep, StoreFailure | ChainUnreachable> {
        return Predicate.isTagged(transfer, "Proposed")
          ? proposedStep(transfer, requirement)
          : yield* signedStep(transfer);
      });

      const redrafted = Effect.fn("Wallet.redrafted")(function* (
        stored: Proposed,
        requirement: Option.Option<KnownExchangeMemo>,
      ) {
        const request = yield* delivery(stored.order, stored.recipient);

        return request instanceof SigningRequest
          ? yield* resumed(
              yield* transfers.redraft(stored, request),
              requirement,
            )
          : request;
      });

      const currentDraft = Effect.fn("Wallet.currentDraft")(function* (
        stored: Proposed,
      ) {
        const state = yield* chain.account(stored.order.from);
        const facts = readEnvelope(stored.request.envelope);

        return (
          Option.isSome(state) &&
          Option.isSome(facts) &&
          (Predicate.isTagged(facts.value, "PaymentFacts") ||
            Predicate.isTagged(facts.value, "ClaimableFacts") ||
            Predicate.isTagged(facts.value, "PaymentLinkFacts")) &&
          BigInt(state.value.sequence) + 1n === BigInt(facts.value.sequence)
        );
      });

      const authorizing = Effect.fn("Wallet.authorizing")(function* (
        stored: Proposed,
        sealed: Sealed,
        requirement: Option.Option<KnownExchangeMemo>,
        mayRetry: boolean,
      ): Effect.fn.Return<TransferStep, StoreFailure | ChainUnreachable> {
        const authorized = yield* transfers.authorize(stored, sealed);

        const retried = () =>
          mayRetry
            ? authorizing(stored, sealed, requirement, false)
            : resumed(stored, requirement);

        return yield* Match.valueTags(authorized, {
          SlotTaken: ({ holder }) =>
            Effect.gen(function* () {
              const receipt = yield* reconcile(holder);

              return Predicate.isTagged(receipt, "Pending")
                ? new SenderBusy({ inFlight: receipt })
                : (yield* currentDraft(stored))
                  ? yield* resumed(stored, requirement)
                  : yield* redrafted(stored, requirement);
            }),
          ClaimablesFull: ({ limit }) =>
            Effect.gen(function* () {
              const full = yield* quotaFull(
                stored.order.from,
                stored.claimableKind ?? "username",
              );

              return full
                ? new ClaimableLimitReached({ limit })
                : yield* retried();
            }),
          SlotOccupied: () =>
            Effect.gen(function* () {
              const busy = yield* assets.inFlightFor(stored.order.from);

              if (Option.isNone(busy)) return proposedStep(stored, requirement);

              if (yield* assetActions.reconcilePending(busy.value))
                return new AssetBusy({ inFlight: assetPending(busy.value) });

              return (yield* currentDraft(stored))
                ? yield* retried()
                : yield* redrafted(stored, requirement);
            }),
          WalletInactive: () => Effect.succeed(new NotOpened()),
          Proposed: (proposed) => resumed(proposed, requirement),
          Authorized: reconcile,
          Concluded: signedStep,
        });
      });

      const transfer = Effect.fn("Wallet.transfer")(function* (
        order: TransferOrder,
        approval: Option.Option<Approval>,
      ): Effect.fn.Return<TransferStep, StoreFailure | ChainUnreachable> {
        if (!chain.validAddress(order.from))
          return new InvalidAddress({ address: order.from });

        const invalidRecipient = Match.valueTags(order.to, {
          Address: ({ value }) =>
            chain.validAddress(value)
              ? Option.none<DestinationAddress>()
              : Option.some(value),
          PaymentLink: ({ value }) =>
            chain.validAddress(value) && value !== order.from
              ? Option.none<DestinationAddress>()
              : Option.some(value),
          Username: () => Option.none<DestinationAddress>(),
          Phone: () => Option.none<DestinationAddress>(),
        });

        if (Option.isSome(invalidRecipient))
          return new InvalidAddress({ address: invalidRecipient.value });

        if (
          Match.valueTags(order.to, {
            Phone: () => true,
            Username: () => false,
            Address: () => false,
            PaymentLink: () => false,
          })
        )
          return new PhoneNotSupported();

        const existing = yield* transfers.find(order.id);

        if (Option.isSome(existing)) {
          const stored = existing.value;

          if (
            Schema.encodeSync(OrderJson)(stored.order) !==
            Schema.encodeSync(OrderJson)(order)
          )
            return yield* new StoreFailure({
              cause: new Error("Transfer id cannot identify a different order"),
            });

          if (!Predicate.isTagged(stored, "Proposed"))
            return yield* signedStep(stored);

          const requirement = yield* memoRequirement(stored.recipient);
          const refusal = memoRefusal(order, stored.recipient, requirement);

          if (Option.isSome(refusal)) return refusal.value;

          if (stored.recipient instanceof LinkRecipient) {
            const linkRefusal = yield* checkLinkAsset(stored.order);

            if (Option.isSome(linkRefusal)) return linkRefusal.value;
          }

          if (!(yield* currentDraft(stored)))
            return yield* redrafted(stored, requirement);

          if (yield* live(stored.request)) {
            if (Option.isNone(approval))
              return proposedStep(stored, requirement);

            const sealed = yield* chain
              .seal(stored.request, approval.value, stored.order.from)
              .pipe(Effect.option);

            if (Option.isNone(sealed)) return proposedStep(stored, requirement);

            if (!(yield* currentDraft(stored)))
              return yield* redrafted(stored, requirement);

            return yield* authorizing(stored, sealed.value, requirement, true);
          }
        }

        const sender = yield* directory.byAddress(order.from);

        if (Option.isNone(sender) || sender.value.status !== "active")
          return new NotOpened();

        const held = yield* transfers.latestFrom(order.from);

        if (
          Option.isSome(held) &&
          Predicate.isTagged(held.value, "Authorized")
        ) {
          const receipt = yield* reconcile(held.value);

          if (Predicate.isTagged(receipt, "Pending"))
            return new SenderBusy({ inFlight: receipt });
        }

        const recipient = yield* Match.valueTags(order.to, {
          Username: ({ value }) =>
            directory
              .byUsername(value)
              .pipe(
                Effect.map((found): ResolvedRecipient | UnknownRecipient =>
                  Option.isSome(found)
                    ? found.value
                    : new UnknownRecipient({ username: value }),
                ),
              ),
          Address: ({ value }) =>
            isMuxed(value)
              ? Effect.succeed<ResolvedRecipient>(
                  new ExternalRecipient({ address: value }),
                )
              : directory
                  .byAddress(value)
                  .pipe(
                    Effect.flatMap(
                      (found): Effect.Effect<ResolvedRecipient, StoreFailure> =>
                        Option.isSome(found) && found.value.status === "active"
                          ? directory.profile(found.value)
                          : Effect.succeed(
                              new ExternalRecipient({ address: value }),
                            ),
                    ),
                  ),
          PaymentLink: ({ value }) =>
            Effect.succeed<ResolvedRecipient>(
              new LinkRecipient({ kind: "paymentLink", address: value }),
            ),
          Phone: () =>
            Effect.die("Phone was rejected before recipient resolution"),
        });

        if (Predicate.isTagged(recipient, "UnknownRecipient")) return recipient;

        const requirement = yield* memoRequirement(recipient);
        const refusal = memoRefusal(order, recipient, requirement);

        if (Option.isSome(refusal)) return refusal.value;

        const state = yield* chain.holdings(
          order.from,
          Match.valueTags(order.asset, {
            Native: () => [],
            Issued: (asset) => [asset],
          }),
        );

        if (Option.isNone(state)) {
          yield* directory.recover(sender.value);

          return new NotOpened();
        }

        if (recipient instanceof LinkRecipient) {
          const linkRefusal = yield* checkLinkAsset(order, state.value);

          if (Option.isSome(linkRefusal)) return linkRefusal.value;
        }

        const balance = Match.valueTags(order.asset, {
          Native: () => state.value.native,
          Issued: (asset) =>
            state.value.lines.find(
              (line) =>
                assetKey(line.asset) === assetKey(asset) && line.authorized,
            )?.spendable ?? Schema.decodeSync(Amount)("0"),
        });

        if (balance < order.amount)
          return new InsufficientBalance({ available: balance });

        const request = yield* delivery(order, recipient, state.value);

        if (!(request instanceof SigningRequest)) return request;

        const proposed = yield* transfers.propose(order, recipient, request);

        return yield* resumed(proposed, requirement);
      });

      const overview = Effect.fn("Wallet.overview")(function* (
        address: AccountAddress,
      ): Effect.fn.Return<Overview, StoreFailure | ChainUnreachable> {
        if (!chain.validAddress(address))
          return new InvalidAddress({ address });

        const row = yield* directory.byAddress(address);

        if (Option.isNone(row)) return new NotOpened();

        if (row.value.status === "recovered")
          return new NeedsReopening({
            profile: yield* directory.profile(row.value),
          });

        if (row.value.status !== "active") return new NotOpened();

        const owner = yield* directory.profile(row.value);
        const latest = yield* transfers.latestFrom(address);

        const receipt: Option.Option<Receipt> = Option.isSome(latest)
          ? yield* Match.valueTags(latest.value, {
              Authorized: (held) =>
                reconcile(held).pipe(Effect.map(Option.some)),
              Concluded: (concluded) =>
                Effect.succeed(Option.some(concluded.receipt)),
              Proposed: () => Effect.succeed(Option.none()),
            })
          : Option.none();

        const balance = yield* readBalance(address);

        if (Option.isNone(balance)) {
          yield* directory.recover(row.value);

          return new NeedsReopening({ profile: owner });
        }

        return new Holding({
          profile: owner,
          ...(yield* portfolio(address)),
          latest: receipt,
        });
      });

      const records = {
        reconcileTransfer: (entry: Authorized) =>
          reconcile(entry).pipe(
            Effect.map((receipt) => Predicate.isTagged(receipt, "Pending")),
          ),
        reconcileAsset: assetActions.reconcilePending,
        cleanUpReceivedLink: assetActions.cleanUpReceivedLink,
      };

      const sweep = yield* sweepFlow({
        ...records,
        closeGoneBalance: links.closeGoneBalance,
      });

      const attend = yield* workFlow(records);

      return Wallet.of({
        manage: (order, approval) => wrap(assetActions.manage(order, approval)),
        open: (claim, approval, humanCheck = Option.none()) =>
          wrap(open(claim, approval, humanCheck)),
        transfer: (order, approval) => wrap(transfer(order, approval)),
        overview: (address) => wrap(overview(address)),
        paymentLinks: (address) => wrap(links.paymentLinks(address)),
        activity: (address, before) => wrap(history(address, before)),
        paymentLink: (link) => wrap(assetActions.paymentLink(link)),
        claimPaymentLink: (order, approval) =>
          wrap(assetActions.claimPaymentLink(order, approval)),
        resolvePaymentLink: (sender, receipt) =>
          wrap(links.resolvePaymentLink(sender, receipt)),
        restoreChallenge: () => wrap(backup.restoreChallenge()),
        enrollmentChallenge: (claim, humanCheck = Option.none()) =>
          wrap(backup.enrollmentChallenge(claim, humanCheck)),
        enroll: (enrollment, approvals) =>
          wrap(backup.enroll(enrollment, approvals)),
        restore: (assertion) => wrap(backup.restore(assertion)),
        sweep: wrap(sweep),
        attend: (work, attempt) => wrap(attend(work, attempt)),
      });
    }),
  );
  static readonly layer = Wallet.serviceLayer.pipe(
    Layer.provide([
      Directory.layer,
      Transfers.layer,
      AssetOrders.layer,
      Backups.layer,
      Chain.layer,
      HumanCheck.layer,
    ]),
  );
}
