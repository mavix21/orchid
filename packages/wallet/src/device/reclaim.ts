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

interface ReclaimTurn {
  readonly done: Option.Option<ReviewReclaimOutcome>;
  readonly pause: boolean;
}

type OnDraft = (
  draft: AssetDraft,
) => Effect.Effect<Option.Option<ReviewReclaimOutcome>>;

export interface ReclaimReviews {
  readonly issued: Ref.Ref<Option.Option<string>>;
  readonly device: SealedDevice | undefined;
}

const afterRelease: OnDraft = () =>
  Effect.succeed(Option.some(new DraftRejected()));

export function deviceReclaim(
  port: WalletPort,
  store: KeyStore,
  reviews: ReclaimReviews,
) {
  const advance = (
    order: AssetOrder,
    onDraft: OnDraft,
    released: Option.Option<Approval> = Option.none(),
  ): Effect.Effect<ReviewReclaimOutcome, WalletUnavailable> =>
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

      return Option.getOrElse(last.done, () => new DraftRejected());
    });

  const latest = Ref.makeUnsafe(0);

  const startPreflight = Ref.updateAndGet(latest, (ticket) => ticket + 1).pipe(
    Effect.tap(() => Ref.set(reviews.issued, Option.none())),
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

        if (standing !== "current" || (yield* Ref.get(latest)) !== ticket)
          return Option.some(new DraftRejected());

        yield* Ref.set(
          reviews.issued,
          Option.some(reviewJson(derived.value.review)),
        );

        return Option.some(derived.value.review);
      });
  };

  const review = Effect.fn("Device.reviewReclaim")(function* (
    target: PaymentLinkTarget,
  ): Effect.fn.Return<
    ReviewReclaimOutcome,
    WalletUnavailable | KeyStoreUnavailable
  > {
    const stored = yield* store.readPublic();

    if (Option.isNone(stored)) return new NoWallet();

    const ticket = yield* startPreflight;

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
    Ref.modify(reviews.issued, (current) =>
      Option.contains(current, snapshot)
        ? [true, Option.none()]
        : [false, current],
    ).pipe(
      Effect.flatMap((consumed): ReturnType<typeof advance> =>
        consumed && !shown.redrafted
          ? startPreflight.pipe(
              Effect.flatMap((ticket) =>
                advance(
                  shown.order,
                  presenting(
                    wallet,
                    shown.order,
                    shown.asset,
                    shown.amount,
                    true,
                    ticket,
                  ),
                ),
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
    const { device, issued } = reviews;

    if (device === undefined) return new UnsupportedDevice();

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
    let released = false;

    if ((yield* standingNow(observed, presented)) === "expiring")
      return yield* redraft(snapshot.value, observed, presented);

    const approved = yield* approveReviewed<
      PublicDeviceWallet,
      never,
      ReviewReclaimOutcome,
      never,
      WalletUnavailable
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

          const consumed = yield* Ref.modify(issued, (current) =>
            Option.contains(current, snapshot.value)
              ? [true, Option.none()]
              : [false, current],
          );

          if (!consumed) return new DraftRejected();

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
