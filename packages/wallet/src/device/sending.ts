import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  type Approval,
  TransferId,
  TransferOrder,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
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
import {
  type DraftHandler,
  type ObserveDraft,
  observeDraft,
} from "./draft-handlers";
import { pendingSteps, pollSchedule } from "./polling";
import {
  draftTiming,
  reviewFromJson,
  reviewJson,
  reviewOf,
  standingNow,
} from "./payment-reviews";
import { approveReviewed } from "./reviewed-approval";
import { reserveApproval, withdrawReservation } from "./transfer-reservation";
import { uncheckedSigning } from "./unchecked-signing";
import {
  approvalOutstanding,
  matchesIntent,
  orderJson,
  orderRevision,
  orderedFacts,
  sameOrderSlot,
} from "./transfer-drafts";

const followAfterExpiry = { minutes: 2 };

const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

interface SendTurn<D> {
  readonly done: Option.Option<D | SendOutcome>;
  readonly pause: boolean;
}

export interface Reviews {
  readonly issued: Ref.Ref<Option.Option<string>>;
  readonly device: SealedDevice | undefined;
}

export function sendTransfer(
  port: WalletPort,
  store: KeyStore,
  reviews?: Reviews,
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

  const presenting =
    (redrafted: boolean): DraftHandler<PaymentReview | DraftRejected> =>
    (wallet, order, draft, _finalStep, refreshed) =>
      Effect.gen(function* () {
        const fresh = redrafted || refreshed;
        const derived = reviewOf(wallet, order, draft, fresh);

        if (Option.isNone(derived))
          return { done: Option.some(new DraftRejected()) };

        const timing = draftTiming(
          derived.value.facts.maxTime,
          draft,
          DateTime.toEpochMillis(yield* DateTime.now),
        );

        if (timing === "expiring" && !fresh)
          return {
            done: Option.none(),
            next: { wallet, approval: Option.none(), refreshed: true },
          };

        if (timing !== "current")
          return { done: Option.some(new DraftRejected()) };

        if (reviews !== undefined)
          yield* Ref.set(
            reviews.issued,
            Option.some(reviewJson(derived.value.review)),
          );

        return { done: Option.some(derived.value.review) };
      });

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
    return yield* prepared(intent, uncheckedSigning(store));
  });

  const review = Effect.fn("Device.review")(function* (intent: TransferIntent) {
    if (Predicate.isTagged(intent.to, "PaymentLink"))
      return new DraftRejected();

    return yield* prepared(intent, presenting(false));
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
    issued: Ref.Ref<Option.Option<string>>,
    snapshot: string,
    wallet: PublicDeviceWallet,
    order: TransferOrder,
    review: PaymentReview,
  ) =>
    Ref.modify(issued, (current) =>
      Option.contains(current, snapshot)
        ? [true, Option.none()]
        : [false, current],
    ).pipe(
      Effect.flatMap((consumed) =>
        consumed && !review.redrafted
          ? advance(wallet, order, presenting(true))
          : Effect.succeed(new DraftRejected()),
      ),
    );

  const confirm = Effect.fn("Device.confirm")(function* (
    shown: PaymentReview,
  ): Effect.fn.Return<
    ConfirmOutcome,
    WalletUnavailable | KeyStoreUnavailable | CorruptDeviceWallet
  > {
    if (reviews?.device === undefined) return new UnsupportedDevice();

    const { device, issued } = reviews;
    const snapshot = yield* Ref.get(issued);

    if (Option.isNone(snapshot) || snapshot.value !== reviewJson(shown))
      return new DraftRejected();

    const presented = reviewFromJson(snapshot.value);

    const issuedHere = Effect.map(Ref.get(issued), (current) =>
      Option.contains(current, snapshot.value),
    );

    const sealed = yield* device.store.readSealed();

    if (Option.isNone(sealed)) return new NoWallet();

    const record = sealed.value;
    const observed = record.public;
    const order = observed.transfer;

    if (order === undefined || orderJson(order) !== orderJson(presented.order))
      return new DraftRejected();

    if (approvalOutstanding(observed, yield* nowSeconds))
      return new ApprovalOutstanding({ order });

    const facts = orderedFacts(observed, order, presented.draft);

    if (Option.isNone(facts)) return new DraftRejected();

    const approvedUntil = facts.value.maxTime;

    if ((yield* standingNow(observed, presented)) === "expiring")
      return yield* redraft(issued, snapshot.value, observed, order, presented);

    const approved = yield* approveReviewed(device, {
      record,
      requests: [presented.draft.request],
      holds: (wallet) =>
        Effect.zipWith(
          standingNow(wallet, presented),
          issuedHere,
          (standing, issued) =>
            issued && sameOrderSlot(wallet, observed) && standing === "current",
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
        (yield* standingNow(latest.value, presented)) === "expiring"
        ? yield* redraft(issued, snapshot.value, latest.value, order, presented)
        : approved;
    }

    return Predicate.isTagged(approved, "Pending")
      ? yield* resume(order.id)
      : approved;
  });

  return { send, review, confirm, resume };
}
