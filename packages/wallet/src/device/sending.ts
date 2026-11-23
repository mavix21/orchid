import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  type Approval,
  type TransferDraft,
  TransferId,
  TransferOrder,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import { approvalMargin, paymentLifetime } from "../stellar/network";
import {
  type CorruptDeviceWallet,
  type KeyStore,
  type KeyStoreUnavailable,
  PublicDeviceWallet,
  type SealedDevice,
} from "./key-store";
import {
  ApprovalOutstanding,
  type ConfirmOutcome,
  DraftRejected,
  NoTransfer,
  NoWallet,
  PaymentReview,
  type ResumeOutcome,
  type SendOutcome,
  type TransferIntent,
  UnsupportedDevice,
} from "./outcomes";
import { pendingSteps, pollSchedule } from "./polling";
import { reviewOf, standingNow } from "./payment-reviews";
import { approveReviewed } from "./reviewed-approval";
import { reserveApproval, withdrawReservation } from "./transfer-reservation";
import { approve, signingKey } from "./signing";
import {
  approvalOutstanding,
  clockAllowance,
  matchesIntent,
  nextLinkReceipt,
  orderJson,
  orderRevision,
  orderedFacts,
  sameOrderSlot,
} from "./transfer-drafts";

const followAfterExpiry = { minutes: 2 };

const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

interface DraftNext {
  readonly wallet: PublicDeviceWallet;
  readonly approval: Option.Option<Approval>;
  readonly refreshed: boolean;
}

interface DraftResult<D> {
  readonly done: Option.Option<D | SendOutcome>;
  readonly next?: DraftNext;
}

interface SendTurn<D> {
  readonly done: Option.Option<D | SendOutcome>;
  readonly pause: boolean;
}

type DraftHandler<D> = (
  wallet: PublicDeviceWallet,
  order: TransferOrder,
  draft: TransferDraft,
  finalStep: boolean,
  refreshed: boolean,
) => Effect.Effect<DraftResult<D>, WalletUnavailable | KeyStoreUnavailable>;

type ObserveDraft<D> = (
  wallet: PublicDeviceWallet,
  order: TransferOrder,
  draft: TransferDraft,
) => Effect.Effect<D | SendOutcome, WalletUnavailable | KeyStoreUnavailable>;

const observeDraft =
  <D>(handler: ObserveDraft<D>): DraftHandler<D> =>
  (wallet, order, draft) =>
    handler(wallet, order, draft).pipe(
      Effect.map((done): DraftResult<D> => ({ done: Option.some(done) })),
    );

export function sendTransfer(
  port: WalletPort,
  store: KeyStore,
  device?: SealedDevice,
) {
  const forget = (address: AccountAddress, order: TransferOrder) =>
    store
      .updatePublic((current) =>
        current.address === address && current.transfer?.id === order.id
          ? Option.some(
              new PublicDeviceWallet({
                ...current,
                transfer: undefined,
                approvedUntil: undefined,
                linkReceipt: undefined,
                transferRevision: orderRevision(current) + 1,
              }),
            )
          : Option.none(),
      )
      .pipe(Effect.asVoid);

  const advance = <D>(
    initial: PublicDeviceWallet,
    order: TransferOrder,
    onDraft: DraftHandler<D>,
    released: Option.Option<Approval> = Option.none(),
  ): Effect.Effect<D | SendOutcome, WalletUnavailable | KeyStoreUnavailable> =>
    Effect.gen(function* () {
      let wallet = initial;
      let approval = released;
      let refreshed = false;
      let attempts = 0;

      const step: Effect.Effect<
        SendTurn<D>,
        WalletUnavailable | KeyStoreUnavailable
      > = Effect.gen(function* () {
        const submitted = Option.isSome(approval);

        attempts++;

        const response = yield* port.transfer(order, approval);

        approval = Option.none();

        return yield* Match.valueTags(response, {
          TransferDraft: (draft) =>
            onDraft(
              wallet,
              order,
              draft,
              attempts >= pendingSteps,
              refreshed,
            ).pipe(
              Effect.map((decision): SendTurn<D> => {
                if (decision.next) {
                  wallet = decision.next.wallet;
                  approval = decision.next.approval;
                  refreshed = decision.next.refreshed;
                }

                return { done: decision.done, pause: false };
              }),
            ),
          Pending: (pending) =>
            Effect.succeed<SendTurn<D>>({
              done:
                attempts >= pendingSteps ? Option.some(pending) : Option.none(),
              pause: !submitted,
            }),
          Settled: (settled) =>
            forget(wallet.address, order).pipe(
              Effect.as<SendTurn<D>>({
                done: Option.some(settled),
                pause: false,
              }),
            ),
          Failed: (failed) =>
            forget(wallet.address, order).pipe(
              Effect.as<SendTurn<D>>({
                done: Option.some(failed),
                pause: false,
              }),
            ),
          NotOpened: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          UnknownRecipient: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          PhoneNotSupported: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          InsufficientBalance: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          SenderBusy: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          InvalidAddress: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          ExternalMemoRequired: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          MemoNotAllowed: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          RecipientCannotReceive: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          ClaimableLimitReached: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          AssetUnsupported: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
          AssetBusy: (outcome) =>
            Effect.succeed({ done: Option.some(outcome), pause: false }),
        });
      });

      const last = yield* Effect.repeat(step, {
        schedule: pollSchedule<SendTurn<D>>(
          (turn) => Option.isNone(turn.done),
          (turn) => turn.pause,
        ),
      });

      return Option.getOrElse(last.done, () => new DraftRejected());
    });

  const signing: DraftHandler<SendOutcome> = (
    wallet,
    order,
    draft,
    finalStep,
    refreshed,
  ) =>
    Effect.gen(function* () {
      const facts = orderedFacts(wallet, order, draft);

      const now = yield* nowSeconds;

      if (
        finalStep ||
        Option.isNone(facts) ||
        approvalOutstanding(wallet, now) ||
        facts.value.maxTime > now + paymentLifetime + clockAllowance
      )
        return { done: Option.some(new DraftRejected()) };

      const deadline = Math.min(
        facts.value.maxTime * 1000,
        DateTime.toEpochMillis(draft.request.expiresAt),
      );

      const withinMargin = Effect.map(
        DateTime.now,
        (current) =>
          deadline - DateTime.toEpochMillis(current) >= approvalMargin * 1000,
      );

      const linkFacts = Predicate.isTagged(facts.value, "PaymentLinkFacts")
        ? facts.value
        : undefined;

      if (!(yield* withinMargin)) {
        if (refreshed) return { done: Option.some(new DraftRejected()) };

        if (linkFacts === undefined)
          return {
            done: Option.none(),
            next: {
              wallet,
              approval: Option.none(),
              refreshed: true,
            },
          };

        const kept = yield* store.updatePublic((current) =>
          current.address === wallet.address &&
          current.transfer?.id === order.id
            ? Option.some(
                new PublicDeviceWallet({
                  ...current,
                  linkReceipt: nextLinkReceipt(current.linkReceipt, linkFacts),
                }),
              )
            : Option.none(),
        );

        if (Option.isNone(kept))
          return { done: Option.some(new UnsupportedDevice()) };

        if (!kept.value.updated)
          return { done: Option.some(new DraftRejected()) };

        return {
          done: Option.none(),
          next: {
            wallet: kept.value.wallet,
            approval: Option.none(),
            refreshed: true,
          },
        };
      }

      const secret = yield* store.read();

      if (Option.isNone(secret) || secret.value.address !== wallet.address)
        return { done: Option.some(new UnsupportedDevice()) };

      if (!(yield* withinMargin))
        return { done: Option.some(new DraftRejected()) };

      const reserveNow = yield* nowSeconds;

      const approved = yield* store.updatePublic((current) =>
        current.address === wallet.address &&
        current.transfer?.id === order.id &&
        !approvalOutstanding(current, reserveNow)
          ? Option.some(
              new PublicDeviceWallet({
                ...current,
                approvedUntil: facts.value.maxTime,
                linkReceipt: linkFacts
                  ? nextLinkReceipt(current.linkReceipt, linkFacts)
                  : current.linkReceipt,
              }),
            )
          : Option.none(),
      );

      if (Option.isNone(approved))
        return { done: Option.some(new UnsupportedDevice()) };

      if (!approved.value.updated) {
        const current = approved.value.wallet;

        return {
          done: Option.some(
            current.address === wallet.address &&
              current.transfer?.id === order.id &&
              approvalOutstanding(current, reserveNow)
              ? new ApprovalOutstanding({ order })
              : new DraftRejected(),
          ),
        };
      }

      if (!(yield* withinMargin))
        return { done: Option.some(new DraftRejected()) };

      return {
        done: Option.none(),
        next: {
          wallet: approved.value.wallet,
          approval: Option.some(
            approve(draft.request, signingKey(secret.value.phrase)),
          ),
          refreshed,
        },
      };
    });

  const reviewing =
    (redrafted: boolean): ObserveDraft<PaymentReview | DraftRejected> =>
    (wallet, order, draft) =>
      Effect.succeed(
        Option.match(reviewOf(wallet, order, draft, redrafted), {
          onNone: () => new DraftRejected(),
          onSome: ({ review }) => review,
        }),
      );

  const observing: ObserveDraft<ApprovalOutstanding | NoTransfer> = (
    wallet,
    order,
  ) =>
    Effect.map(nowSeconds, (now) =>
      approvalOutstanding(wallet, now)
        ? new ApprovalOutstanding({ order })
        : new NoTransfer(),
    );

  const prepared = <D>(
    intent: TransferIntent,
    onDraft: DraftHandler<D>,
  ): Effect.Effect<D | SendOutcome, WalletUnavailable | KeyStoreUnavailable> =>
    Effect.gen(function* () {
      const stored = yield* store.readPublic();

      if (Option.isNone(stored)) return new NoWallet();

      let observed = stored.value;
      const address = observed.address;

      for (let attempt = 0; attempt < 2; attempt++) {
        if (matchesIntent(observed, intent) && observed.transfer !== undefined)
          return yield* advance(observed, observed.transfer, onDraft);

        let reconciled = false;

        if (
          observed.transfer !== undefined &&
          observed.approvedUntil !== undefined
        ) {
          const signed = yield* port.transfer(observed.transfer, Option.none());
          const now = yield* nowSeconds;

          const resolved =
            Predicate.isTagged(signed, "Settled") ||
            Predicate.isTagged(signed, "Failed") ||
            (!Predicate.isTagged(signed, "Pending") &&
              !approvalOutstanding(observed, now));

          if (!resolved)
            return new ApprovalOutstanding({ order: observed.transfer });

          reconciled = true;
        }

        const candidate = new TransferOrder({
          ...intent,
          id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
          from: address,
        });

        const expected = observed;

        const claimed = yield* store.updatePublic((current) => {
          if (current.address !== address) return Option.none();

          if (matchesIntent(current, intent)) return Option.none();

          const unchanged = sameOrderSlot(current, expected);

          const clearedObserved =
            reconciled &&
            current.transfer === undefined &&
            orderRevision(current) === orderRevision(expected) + 1;

          if (!unchanged && !clearedObserved) return Option.none();

          return Option.some(
            new PublicDeviceWallet({
              ...current,
              transfer: candidate,
              approvedUntil: undefined,
              linkReceipt: undefined,
              transferRevision: orderRevision(current) + 1,
            }),
          );
        });

        if (Option.isNone(claimed)) return new NoWallet();

        const wallet = claimed.value.wallet;

        if (wallet.address !== address) return new UnsupportedDevice();

        if (matchesIntent(wallet, intent) && wallet.transfer !== undefined)
          return yield* advance(wallet, wallet.transfer, onDraft);

        if (
          wallet.transfer !== undefined &&
          wallet.approvedUntil !== undefined &&
          observed.transfer !== undefined &&
          wallet.transfer.id === observed.transfer.id &&
          orderRevision(wallet) === orderRevision(observed)
        ) {
          if (attempt === 0) {
            observed = wallet;
            continue;
          }

          return new ApprovalOutstanding({ order: wallet.transfer });
        }

        return new DraftRejected();
      }

      return new DraftRejected();
    });

  const send = Effect.fn("Device.send")(function* (intent: TransferIntent) {
    return yield* prepared(intent, signing);
  });

  const review = Effect.fn("Device.review")(function* (intent: TransferIntent) {
    if (Predicate.isTagged(intent.to, "PaymentLink"))
      return new DraftRejected();

    return yield* prepared(intent, observeDraft(reviewing(false)));
  });

  const observed = (wallet: PublicDeviceWallet, id: TransferId) =>
    wallet.transfer?.id === id && wallet.approvedUntil !== undefined
      ? advance(wallet, wallet.transfer, observeDraft(observing))
      : Effect.succeed(new NoTransfer());

  const recorded = (address: AccountAddress, id: TransferId) =>
    port
      .overview(address)
      .pipe(
        Effect.map((overview) =>
          Predicate.isTagged(overview, "Holding")
            ? Option.filter(overview.latest, (receipt) => receipt.id === id)
            : Option.none(),
        ),
      );

  const observedNow = (id: TransferId) =>
    store
      .readPublic()
      .pipe(
        Effect.flatMap((current) =>
          Option.isSome(current)
            ? observed(current.value, id)
            : Effect.succeed(new NoWallet()),
        ),
      );

  const following = (id: TransferId) =>
    observedNow(id).pipe(
      Effect.repeat({
        while: (answered) =>
          Predicate.isTagged(answered, "Pending")
            ? Effect.map(DateTime.now, (now) =>
                DateTime.isLessThanOrEqualTo(
                  now,
                  DateTime.add(answered.expiresAt, followAfterExpiry),
                ),
              )
            : false,
      }),
    );

  const resume = Effect.fn("Device.resume")(function* (
    id: TransferId,
  ): Effect.fn.Return<ResumeOutcome, WalletUnavailable | KeyStoreUnavailable> {
    const stored = yield* store.readPublic();

    if (Option.isNone(stored)) return new NoWallet();

    const answered = yield* following(id);

    if (!Predicate.isTagged(answered, "NoTransfer")) return answered;

    return Option.getOrElse(
      yield* recorded(stored.value.address, id),
      (): ResumeOutcome => answered,
    );
  });

  const redraft = (
    wallet: PublicDeviceWallet,
    order: TransferOrder,
    shown: PaymentReview,
  ) =>
    shown.redrafted
      ? Effect.succeed(new DraftRejected())
      : advance(wallet, order, observeDraft(reviewing(true)));

  const confirm = Effect.fn("Device.confirm")(function* (
    shown: PaymentReview,
  ): Effect.fn.Return<
    ConfirmOutcome,
    WalletUnavailable | KeyStoreUnavailable | CorruptDeviceWallet
  > {
    if (device === undefined) return new UnsupportedDevice();

    const sealed = yield* device.store.readSealed();

    if (Option.isNone(sealed)) return new NoWallet();

    const record = sealed.value;
    const observed = record.public;
    const order = observed.transfer;

    if (order === undefined || orderJson(order) !== orderJson(shown.order))
      return new DraftRejected();

    if (approvalOutstanding(observed, yield* nowSeconds))
      return new ApprovalOutstanding({ order });

    const facts = orderedFacts(observed, order, shown.draft);

    if (Option.isNone(facts)) return new DraftRejected();

    const approvedUntil = facts.value.maxTime;

    if ((yield* standingNow(observed, shown)) === "expiring")
      return yield* redraft(observed, order, shown);

    const approved = yield* approveReviewed(device, {
      record,
      requests: [shown.draft.request],
      holds: (wallet) =>
        Effect.map(
          standingNow(wallet, shown),
          (standing) =>
            sameOrderSlot(wallet, observed) && standing === "current",
        ),
      reserve: (wallet) =>
        reserveApproval(device.store, wallet, order, approvedUntil),
      unreserve: (reservation) =>
        withdrawReservation(device.store, reservation, observed.approvedUntil),
      release: ([approval], reservation) =>
        advance(
          reservation,
          order,
          observeDraft(observing),
          Option.some(approval),
        ),
    });

    if (Predicate.isTagged(approved, "DraftRejected")) {
      const latest = yield* device.store.readPublic();

      return Option.isSome(latest) &&
        sameOrderSlot(latest.value, observed) &&
        (yield* standingNow(latest.value, shown)) === "expiring"
        ? yield* redraft(latest.value, order, shown)
        : approved;
    }

    return Predicate.isTagged(approved, "Pending")
      ? yield* resume(order.id)
      : approved;
  });

  return { send, review, confirm, resume };
}
