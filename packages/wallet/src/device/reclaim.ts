import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  type Approval,
  type Asset,
  type AssetDraft,
  AssetOrder,
  AssetOrderId,
  ClaimBalance,
  type PositiveAmount,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import type {
  CorruptDeviceWallet,
  KeyStore,
  KeyStoreUnavailable,
  PublicDeviceWallet,
  SealedDevice,
} from "./key-store";
import {
  type ConfirmReclaimOutcome,
  DraftRejected,
  NoWallet,
  type PaymentLinkTarget,
  type ReclaimOutcome,
  ReclaimReview,
  type ReviewReclaimOutcome,
  UnsupportedDevice,
} from "./outcomes";
import { pendingSteps, pollSchedule } from "./polling";
import {
  reviewFromJson,
  reviewJson,
  reviewOf,
  standingNow,
} from "./reclaim-reviews";
import { Reserved, approveReviewed } from "./reviewed-approval";
import { recordsStore, withoutReclaimed } from "./saved-links";

interface ReclaimTurn {
  readonly done: Option.Option<ReviewReclaimOutcome>;
  readonly pause: boolean;
}

type OnDraft = (
  draft: AssetDraft,
) => Effect.Effect<Option.Option<ReviewReclaimOutcome>>;

export interface ReclaimIssue {
  readonly ticket: number;
  readonly issued: Option.Option<string>;
}

export interface ReclaimReviews {
  readonly state: Ref.Ref<ReclaimIssue>;
  readonly device: SealedDevice | undefined;
}

const afterRelease: OnDraft = () =>
  Effect.succeed(Option.some(new DraftRejected()));

export function deviceReclaim(
  port: WalletPort,
  store: KeyStore,
  reviews: ReclaimReviews,
) {
  const records = recordsStore(store, reviews.device?.store);

  const forgetReclaimed = (
    order: AssetOrder,
    outcome: ReviewReclaimOutcome,
  ) => {
    const { action } = order;

    return Predicate.isTagged(action, "ClaimBalance") &&
      (Predicate.isTagged(outcome, "AssetSettled") ||
        Predicate.isTagged(outcome, "BalanceGone"))
      ? records
          .updateRecords(({ wallet, links }) =>
            wallet.address === order.wallet
              ? Option.some({
                  wallet,
                  links: withoutReclaimed(
                    links,
                    wallet.address,
                    action.balance,
                  ),
                })
              : Option.none(),
          )
          .pipe(Effect.asVoid)
      : Effect.void;
  };

  const advance = (
    order: AssetOrder,
    onDraft: OnDraft,
    released: Option.Option<Approval> = Option.none(),
  ): Effect.Effect<
    ReviewReclaimOutcome,
    WalletUnavailable | KeyStoreUnavailable
  > =>
    Effect.gen(function* () {
      let approval = released;
      let attempts = 0;

      const step: Effect.Effect<ReclaimTurn, WalletUnavailable> = Effect.gen(
        function* () {
          const submitted = Option.isSome(approval);

          attempts++;

          const response = yield* port.manage(order, approval);

          approval = Option.none();

          return yield* Match.value(response).pipe(
            Match.tag("AssetDraft", (draft) =>
              Effect.map(onDraft(draft), (done): ReclaimTurn => ({
                done,
                pause: false,
              })),
            ),
            Match.tag("AssetPending", (pending) =>
              Effect.succeed<ReclaimTurn>({
                done:
                  attempts >= pendingSteps
                    ? Option.some(pending)
                    : Option.none(),
                pause: !submitted,
              }),
            ),
            Match.orElse((outcome: ReclaimOutcome) =>
              Effect.succeed<ReclaimTurn>({
                done: Option.some(outcome),
                pause: false,
              }),
            ),
          );
        },
      );

      const last = yield* Effect.repeat(step, {
        schedule: pollSchedule<ReclaimTurn>(
          (turn) => Option.isNone(turn.done),
          (turn) => turn.pause,
        ),
      });

      const outcome = Option.getOrElse(
        last.done,
        (): ReviewReclaimOutcome => new DraftRejected(),
      );

      yield* forgetReclaimed(order, outcome);

      return outcome;
    });

  const startPreflight = Ref.modify(reviews.state, (current) => [
    current.ticket + 1,
    { ticket: current.ticket + 1, issued: Option.none() },
  ]);

  const publish = (ticket: number, snapshot: string) =>
    Ref.modify(reviews.state, (current) =>
      current.ticket === ticket
        ? [true, { ticket, issued: Option.some(snapshot) }]
        : [false, current],
    );

  const consume = (snapshot: string) =>
    Ref.modify(reviews.state, (current) =>
      Option.contains(current.issued, snapshot)
        ? [true, { ticket: current.ticket, issued: Option.none() }]
        : [false, current],
    );

  const presenting = (
    wallet: PublicDeviceWallet,
    order: AssetOrder,
    asset: Asset,
    amount: PositiveAmount,
    redrafted: boolean,
    ticket: number,
  ): OnDraft => {
    let refreshed = false;

    return (draft) =>
      Effect.gen(function* (): Effect.fn.Return<
        Option.Option<ReviewReclaimOutcome>
      > {
        const derived = reviewOf(
          wallet,
          order,
          draft,
          redrafted || refreshed,
          asset,
          amount,
        );

        if (Option.isNone(derived)) return Option.some(new DraftRejected());

        const standing = yield* standingNow(wallet, derived.value.review);

        if (standing === "expiring" && !refreshed && !redrafted) {
          refreshed = true;

          return Option.none();
        }

        if (
          standing !== "current" ||
          !(yield* publish(ticket, reviewJson(derived.value.review)))
        )
          return Option.some(new DraftRejected());

        return Option.some(derived.value.review);
      });
  };

  const review = Effect.fn("Device.reviewReclaim")(function* (
    target: PaymentLinkTarget,
  ): Effect.fn.Return<
    ReviewReclaimOutcome,
    WalletUnavailable | KeyStoreUnavailable
  > {
    const ticket = yield* startPreflight;
    const stored = yield* store.readPublic();

    if (Option.isNone(stored)) return new NoWallet();

    const order = new AssetOrder({
      id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
      wallet: stored.value.address,
      action: ClaimBalance.make({ balance: target.balance }),
    });

    return yield* advance(
      order,
      presenting(
        stored.value,
        order,
        target.asset,
        target.amount,
        false,
        ticket,
      ),
    );
  });

  const redraft = (
    snapshot: string,
    wallet: PublicDeviceWallet,
    shown: ReclaimReview,
  ) =>
    Ref.modify(
      reviews.state,
      (current): [Option.Option<number>, ReclaimIssue] =>
        Option.contains(current.issued, snapshot)
          ? [
              Option.some(current.ticket + 1),
              { ticket: current.ticket + 1, issued: Option.none() },
            ]
          : [Option.none(), current],
    ).pipe(
      Effect.flatMap((ticket): ReturnType<typeof advance> =>
        Option.isSome(ticket) && !shown.redrafted
          ? advance(
              shown.order,
              presenting(
                wallet,
                shown.order,
                shown.asset,
                shown.amount,
                true,
                ticket.value,
              ),
            )
          : Effect.succeed(new DraftRejected()),
      ),
    );

  const confirm = Effect.fn("Device.confirmReclaim")(function* (
    shown: ReclaimReview,
  ): Effect.fn.Return<
    ConfirmReclaimOutcome,
    WalletUnavailable | KeyStoreUnavailable | CorruptDeviceWallet
  > {
    const { device } = reviews;

    if (device === undefined) return new UnsupportedDevice();

    const { issued: snapshot } = yield* Ref.get(reviews.state);

    if (Option.isNone(snapshot) || snapshot.value !== reviewJson(shown))
      return new DraftRejected();

    const presented = reviewFromJson(snapshot.value);

    const issuedHere = Effect.map(Ref.get(reviews.state), (current) =>
      Option.contains(current.issued, snapshot.value),
    );

    const sealed = yield* device.store.readSealed();

    if (Option.isNone(sealed)) return new NoWallet();

    const record = sealed.value;
    const observed = record.public;
    let released = false;

    if ((yield* standingNow(observed, presented)) === "expiring")
      return yield* redraft(snapshot.value, observed, presented);

    const approved = yield* approveReviewed<
      PublicDeviceWallet,
      never,
      ReviewReclaimOutcome,
      never,
      WalletUnavailable | KeyStoreUnavailable
    >(device, {
      record,
      requests: [presented.draft.request],
      holds: (wallet) =>
        Effect.zipWith(
          standingNow(wallet, presented),
          issuedHere,
          (standing, current) => current && standing === "current",
        ),
      reserve: (wallet) =>
        Effect.succeed(new Reserved({ reservation: wallet })),
      unreserve: () => Effect.void,
      release: ([approval], reservation) =>
        Effect.gen(function* () {
          if ((yield* standingNow(reservation, presented)) !== "current")
            return new DraftRejected();

          if (!(yield* consume(snapshot.value))) return new DraftRejected();

          released = true;

          return yield* advance(
            presented.order,
            afterRelease,
            Option.some(approval),
          );
        }),
    });

    if (!released && Predicate.isTagged(approved, "DraftRejected")) {
      const latest = yield* device.store.readPublic();

      return Option.isSome(latest) &&
        (yield* standingNow(latest.value, presented)) === "expiring"
        ? yield* redraft(snapshot.value, latest.value, presented)
        : approved;
    }

    return approved;
  });

  return { review, confirm };
}
