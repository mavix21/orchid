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
  type KeyStore,
  type KeyStoreUnavailable,
  PublicDeviceWallet,
} from "./key-store";
import {
  ApprovalOutstanding,
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
import { approve, signingKey } from "./signing";
import {
  approvalOutstanding,
  clockAllowance,
  matchesIntent,
  nextLinkReceipt,
  orderJson,
  orderedFacts,
  reviewed,
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

export function sendTransfer(port: WalletPort, store: KeyStore) {
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
              }),
            )
          : Option.none(),
      )
      .pipe(Effect.asVoid);

  const advance = <D>(
    initial: PublicDeviceWallet,
    order: TransferOrder,
    onDraft: DraftHandler<D>,
  ): Effect.Effect<D | SendOutcome, WalletUnavailable | KeyStoreUnavailable> =>
    Effect.gen(function* () {
      let wallet = initial;
      let approval: Option.Option<Approval> = Option.none();
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

  const signing =
    (review: Option.Option<PaymentReview>): DraftHandler<SendOutcome> =>
    (wallet, order, draft, finalStep, refreshed) =>
      Effect.gen(function* () {
        const facts = orderedFacts(wallet, order, draft).pipe(
          Option.filter(reviewed(review)),
        );

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
                    linkReceipt: nextLinkReceipt(
                      current.linkReceipt,
                      linkFacts,
                    ),
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

        const approved = yield* store.updatePublic((current) =>
          current.address === wallet.address &&
          current.transfer?.id === order.id &&
          !approvalOutstanding(current, now)
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
                approvalOutstanding(current, now)
                ? new ApprovalOutstanding({ order })
                : new DraftRejected(),
            ),
          };
        }

        if (!(yield* withinMargin))
          return { done: Option.some(new DraftRejected()) };

        const secret = yield* store.read();

        if (Option.isNone(secret) || secret.value.address !== wallet.address)
          return { done: Option.some(new UnsupportedDevice()) };

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

  const reviewing: ObserveDraft<PaymentReview | DraftRejected> = (
    wallet,
    order,
    draft,
  ) =>
    Effect.gen(function* () {
      const facts = orderedFacts(wallet, order, draft);

      if (Option.isNone(facts)) return new DraftRejected();

      if (Predicate.isTagged(facts.value, "PaymentLinkFacts")) {
        const linkFacts = facts.value;

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

        if (Option.isNone(kept)) return new UnsupportedDevice();

        if (!kept.value.updated) return new DraftRejected();
      }

      return new PaymentReview({
        order,
        to: facts.value.to,
        username: Predicate.isTagged(order.to, "Username")
          ? order.to.value
          : undefined,
        asset: facts.value.asset,
        amount: facts.value.amount,
        memo: Predicate.isTagged(facts.value, "PaymentFacts")
          ? facts.value.memo
          : undefined,
        claimable:
          Predicate.isTagged(facts.value, "ClaimableFacts") ||
          Predicate.isTagged(facts.value, "PaymentLinkFacts"),
        memoRequired: draft.memoRequired,
      });
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

      const initial = stored.value;
      const kept = initial.transfer;

      if (matchesIntent(initial, intent) && kept !== undefined)
        return yield* advance(initial, kept, onDraft);

      let resolvedId: TransferId | undefined;

      if (kept !== undefined && initial.approvedUntil !== undefined) {
        const signed = yield* port.transfer(kept, Option.none());
        const now = yield* nowSeconds;

        const resolved =
          Predicate.isTagged(signed, "Settled") ||
          Predicate.isTagged(signed, "Failed") ||
          (!Predicate.isTagged(signed, "Pending") &&
            !approvalOutstanding(initial, now));

        if (!resolved) return new ApprovalOutstanding({ order: kept });

        resolvedId = kept.id;
      }

      const candidate = new TransferOrder({
        ...intent,
        id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
        from: initial.address,
      });

      const claimed = yield* store.updatePublic((current) => {
        if (current.address !== initial.address) return Option.none();

        if (matchesIntent(current, intent)) return Option.none();

        if (
          current.transfer !== undefined &&
          current.approvedUntil !== undefined &&
          current.transfer.id !== resolvedId
        )
          return Option.none();

        return Option.some(
          new PublicDeviceWallet({
            ...current,
            transfer: candidate,
            approvedUntil: undefined,
            linkReceipt: undefined,
          }),
        );
      });

      if (Option.isNone(claimed)) return new NoWallet();

      const wallet = claimed.value.wallet;

      if (wallet.address !== initial.address) return new UnsupportedDevice();

      if (matchesIntent(wallet, intent) && wallet.transfer !== undefined)
        return yield* advance(wallet, wallet.transfer, onDraft);

      if (wallet.transfer !== undefined && wallet.approvedUntil !== undefined)
        return new ApprovalOutstanding({ order: wallet.transfer });

      return new UnsupportedDevice();
    });

  const send = Effect.fn("Device.send")(function* (intent: TransferIntent) {
    return yield* prepared(intent, signing(Option.none()));
  });

  const review = Effect.fn("Device.review")(function* (intent: TransferIntent) {
    return yield* prepared(intent, observeDraft(reviewing));
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

  const confirm = Effect.fn("Device.confirm")(function* (
    shown: PaymentReview,
  ): Effect.fn.Return<ResumeOutcome, WalletUnavailable | KeyStoreUnavailable> {
    const stored = yield* store.readPublic();

    if (Option.isNone(stored)) return new NoWallet();

    const kept = stored.value.transfer;

    if (kept === undefined || orderJson(kept) !== orderJson(shown.order))
      return new DraftRejected();

    const answered = yield* advance(
      stored.value,
      kept,
      signing(Option.some(shown)),
    );

    return Predicate.isTagged(answered, "Pending")
      ? yield* resume(kept.id)
      : answered;
  });

  return { send, review, confirm, resume };
}
