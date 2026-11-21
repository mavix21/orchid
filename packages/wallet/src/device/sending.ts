import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type DestinationAddress,
  type Approval,
  LinkRecipient,
  PaymentLinkReceipt,
  type PaymentMemo,
  Profile,
  type TransferDraft,
  TransferId,
  TransferOrder,
  type WalletPort,
  type WalletUnavailable,
  assetKey,
} from "../contract";
import type {
  ClaimableFacts,
  PaymentLinkFacts,
} from "../stellar/asset-envelopes";
import { type PaymentFacts, readEnvelope } from "../stellar/envelopes";
import { approvalMargin, network, paymentLifetime } from "../stellar/network";
import {
  DeviceWallet,
  type KeyStore,
  type KeyStoreUnavailable,
  remember,
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

const orderJson = Schema.encodeSync(Schema.fromJsonString(TransferOrder));

const sameMemo = (
  drafted: PaymentMemo | undefined,
  ordered: PaymentMemo | undefined,
) => drafted?.type === ordered?.type && drafted?.value === ordered?.value;

const destination = (order: TransferOrder, draft: TransferDraft) =>
  Match.valueTags(order.to, {
    Address: ({ value }) => Option.some(value),
    Username: ({ value }) =>
      draft.recipient instanceof Profile && draft.recipient.username === value
        ? Option.some<DestinationAddress>(draft.recipient.address)
        : Option.none<DestinationAddress>(),
    PaymentLink: ({ value }) =>
      draft.recipient instanceof LinkRecipient &&
      draft.recipient.address === value
        ? Option.some<DestinationAddress>(value)
        : Option.none<DestinationAddress>(),
    Phone: () => Option.none<DestinationAddress>(),
  });

const clockAllowance = 60;

const followAfterExpiry = { minutes: 2 };

const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

const approvalOutstanding = (wallet: DeviceWallet, now: number) =>
  wallet.approvedUntil !== undefined &&
  wallet.approvedUntil + clockAllowance >= now;

const nextLinkReceipt = (
  current: PaymentLinkReceipt | undefined,
  facts: PaymentLinkFacts,
) => {
  const prior = current && current.network === network ? current.attempts : [];

  const attempts = prior.includes(facts.balance)
    ? prior
    : [...prior, facts.balance];

  return new PaymentLinkReceipt({
    network,
    balance: facts.balance,
    attempts,
  });
};

const orderedFacts = (
  wallet: DeviceWallet,
  order: TransferOrder,
  draft: TransferDraft,
) => {
  const facts = readEnvelope(draft.request.envelope);
  const to = destination(order, draft);

  if (Option.isNone(facts) || Option.isNone(to)) return Option.none();

  const drafted = facts.value;

  if (
    !(
      Predicate.isTagged(drafted, "PaymentFacts") ||
      Predicate.isTagged(drafted, "ClaimableFacts") ||
      Predicate.isTagged(drafted, "PaymentLinkFacts")
    )
  )
    return Option.none();

  const moves =
    drafted.from === wallet.address &&
    drafted.to === to.value &&
    assetKey(drafted.asset) === assetKey(order.asset) &&
    drafted.amount === order.amount;

  const matches = Predicate.isTagged(drafted, "PaymentLinkFacts")
    ? moves &&
      Predicate.isTagged(order.to, "PaymentLink") &&
      order.memo === undefined &&
      draft.recipient instanceof LinkRecipient &&
      draft.recipient.address === drafted.to &&
      wallet.reserveSponsor !== undefined &&
      drafted.reserveSponsor === wallet.reserveSponsor &&
      (draft.claimable === undefined || draft.claimable === drafted.balance)
    : Predicate.isTagged(order.to, "PaymentLink")
      ? false
      : Predicate.isTagged(drafted, "PaymentFacts")
        ? moves && sameMemo(drafted.memo, order.memo)
        : moves &&
          order.memo === undefined &&
          draft.recipient instanceof Profile &&
          wallet.reserveSponsor !== undefined &&
          drafted.reserveSponsor === wallet.reserveSponsor &&
          (draft.claimable === undefined ||
            draft.claimable === drafted.balance);

  return matches ? Option.some(drafted) : Option.none();
};

interface DraftNext {
  readonly wallet: DeviceWallet;
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
  wallet: DeviceWallet,
  order: TransferOrder,
  draft: TransferDraft,
  finalStep: boolean,
  refreshed: boolean,
) => Effect.Effect<DraftResult<D>, WalletUnavailable | KeyStoreUnavailable>;

const reviewed =
  (review: Option.Option<PaymentReview>) =>
  (facts: PaymentFacts | ClaimableFacts | PaymentLinkFacts) =>
    Option.match(review, {
      onNone: () => true,
      onSome: (shown) =>
        facts.to === shown.to &&
        (Predicate.isTagged(facts, "ClaimableFacts") ||
          Predicate.isTagged(facts, "PaymentLinkFacts")) === shown.claimable,
    });

export function sendTransfer(port: WalletPort, store: KeyStore) {
  const forget = (order: TransferOrder) =>
    Effect.gen(function* () {
      const stored = yield* store.read();

      if (Option.isSome(stored) && stored.value.transfer?.id === order.id)
        yield* store.write(
          new DeviceWallet({
            ...stored.value,
            transfer: undefined,
            approvedUntil: undefined,
            linkReceipt: undefined,
          }),
        );
    });

  const advance = <D>(
    initial: DeviceWallet,
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
            forget(order).pipe(
              Effect.as<SendTurn<D>>({
                done: Option.some(settled),
                pause: false,
              }),
            ),
          Failed: (failed) =>
            forget(order).pipe(
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

        const nextWallet = Predicate.isTagged(facts.value, "PaymentLinkFacts")
          ? new DeviceWallet({
              ...wallet,
              linkReceipt: nextLinkReceipt(wallet.linkReceipt, facts.value),
            })
          : wallet;

        if (!(yield* withinMargin)) {
          if (refreshed) return { done: Option.some(new DraftRejected()) };

          const kept = Predicate.isTagged(facts.value, "PaymentLinkFacts")
            ? yield* remember(store, nextWallet)
            : Option.some(wallet);

          if (Option.isNone(kept))
            return { done: Option.some(new UnsupportedDevice()) };

          return {
            done: Option.none(),
            next: {
              wallet: kept.value,
              approval: Option.none(),
              refreshed: true,
            },
          };
        }

        const approved = yield* remember(
          store,
          new DeviceWallet({
            ...nextWallet,
            approvedUntil: facts.value.maxTime,
          }),
        );

        if (Option.isNone(approved))
          return { done: Option.some(new UnsupportedDevice()) };

        if (!(yield* withinMargin))
          return { done: Option.some(new DraftRejected()) };

        return {
          done: Option.none(),
          next: {
            wallet: approved.value,
            approval: Option.some(
              approve(draft.request, signingKey(wallet.phrase)),
            ),
            refreshed,
          },
        };
      });

  const reviewing: DraftHandler<PaymentReview | DraftRejected> = (
    wallet,
    order,
    draft,
  ) =>
    Effect.gen(function* () {
      const facts = orderedFacts(wallet, order, draft);

      if (Option.isNone(facts))
        return { done: Option.some(new DraftRejected()) };

      if (Predicate.isTagged(facts.value, "PaymentLinkFacts")) {
        const kept = yield* remember(
          store,
          new DeviceWallet({
            ...wallet,
            linkReceipt: nextLinkReceipt(wallet.linkReceipt, facts.value),
          }),
        );

        if (Option.isNone(kept))
          return { done: Option.some(new UnsupportedDevice()) };
      }

      return {
        done: Option.some(
          new PaymentReview({
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
          }),
        ),
      };
    });

  const observing: DraftHandler<ApprovalOutstanding | NoTransfer> = (
    wallet,
    order,
  ) =>
    Effect.map(nowSeconds, (now) => ({
      done: Option.some(
        approvalOutstanding(wallet, now)
          ? new ApprovalOutstanding({ order })
          : new NoTransfer(),
      ),
    }));

  const prepared = <D>(
    intent: TransferIntent,
    onDraft: DraftHandler<D>,
  ): Effect.Effect<D | SendOutcome, WalletUnavailable | KeyStoreUnavailable> =>
    Effect.gen(function* () {
      const stored = yield* store.read();

      if (Option.isNone(stored)) return new NoWallet();

      const wallet = stored.value;
      const kept = wallet.transfer;

      const replayed =
        kept !== undefined &&
        orderJson(kept) ===
          orderJson(
            new TransferOrder({ ...intent, id: kept.id, from: wallet.address }),
          );

      if (
        !replayed &&
        kept !== undefined &&
        wallet.approvedUntil !== undefined
      ) {
        const signed = yield* port.transfer(kept, Option.none());
        const now = yield* nowSeconds;

        const resolved =
          Predicate.isTagged(signed, "Settled") ||
          Predicate.isTagged(signed, "Failed") ||
          (!Predicate.isTagged(signed, "Pending") &&
            !approvalOutstanding(wallet, now));

        if (!resolved) return new ApprovalOutstanding({ order: kept });
      }

      const order = replayed
        ? kept
        : new TransferOrder({
            ...intent,
            id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
            from: wallet.address,
          });

      const ready = replayed
        ? Option.some(wallet)
        : yield* remember(
            store,
            new DeviceWallet({
              ...wallet,
              transfer: order,
              approvedUntil: undefined,
              linkReceipt: undefined,
            }),
          );

      if (Option.isNone(ready)) return new UnsupportedDevice();

      return yield* advance(ready.value, order, onDraft);
    });

  const send = Effect.fn("Device.send")(function* (intent: TransferIntent) {
    return yield* prepared(intent, signing(Option.none()));
  });

  const review = Effect.fn("Device.review")(function* (intent: TransferIntent) {
    return yield* prepared(intent, reviewing);
  });

  const observed = (wallet: DeviceWallet, id: TransferId) =>
    wallet.transfer?.id === id && wallet.approvedUntil !== undefined
      ? advance(wallet, wallet.transfer, observing)
      : Effect.succeed(new NoTransfer());

  const recorded = (wallet: DeviceWallet, id: TransferId) =>
    port
      .overview(wallet.address)
      .pipe(
        Effect.map((overview) =>
          Predicate.isTagged(overview, "Holding")
            ? Option.filter(overview.latest, (receipt) => receipt.id === id)
            : Option.none(),
        ),
      );

  const observedNow = (id: TransferId) =>
    store
      .read()
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
    const stored = yield* store.read();

    if (Option.isNone(stored)) return new NoWallet();

    const answered = yield* following(id);

    if (!Predicate.isTagged(answered, "NoTransfer")) return answered;

    return Option.getOrElse(
      yield* recorded(stored.value, id),
      (): ResumeOutcome => answered,
    );
  });

  const confirm = Effect.fn("Device.confirm")(function* (
    shown: PaymentReview,
  ): Effect.fn.Return<ResumeOutcome, WalletUnavailable | KeyStoreUnavailable> {
    const stored = yield* store.read();

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
