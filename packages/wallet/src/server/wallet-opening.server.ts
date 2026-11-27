import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import {
  type AccountAddress,
  AddressBound,
  type Approval,
  type Approvals,
  type UnclaimedFundsId,
  HumanCheckRefused,
  type HumanCheckToken,
  InvalidAddress,
  NotSponsored,
  Opened,
  OpeningDraft,
  OpeningPending,
  OpenStep,
  Profile,
  UsernameTaken,
  WalletClaim,
  sameAsset,
  baseAsset,
} from "../contract";
import {
  Chain,
  ChainUnreachable,
  Sealed,
  type Settlement,
} from "./Chain.server";
import { Directory, StoreFailure, type WalletRow } from "./Directory.server";
import { Transfers } from "./Transfers.server";
import {
  type Binding,
  checkedBinding,
  unavailability,
} from "./username-standing.server";
import { HumanCheck } from "./HumanCheck.server";
import { openingAttempt } from "./opening-attempt.server";
import { confirmedReads, live } from "./wallet-reads.server";

export const openingFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const directory = yield* Directory;
  const humanCheck = yield* HumanCheck;
  const transfers = yield* Transfers;
  const { readStanding } = yield* confirmedReads;

  const waitingClaim = Effect.fn("Wallet.waitingClaim")(function* (
    address: AccountAddress,
  ): Effect.fn.Return<
    Option.Option<UnclaimedFundsId>,
    StoreFailure | ChainUnreachable
  > {
    const waiting = yield* transfers.waitingUnclaimedFunds(address);

    if (waiting.length === 0) return Option.none();

    const entries = yield* chain.unclaimedFunds(waiting);
    const now = yield* DateTime.now;

    return Option.fromNullishOr(
      waiting.find((unclaimedFunds) =>
        entries.some(
          (entry) =>
            entry.unclaimedFunds === unclaimedFunds &&
            sameAsset(entry.asset, baseAsset) &&
            Option.exists(entry.claimOf(address), (claim) =>
              claim.claimableAt(now),
            ),
        ),
      ),
    );
  });

  const openedOrBound = Effect.fn("Wallet.openedOrBound")(function* (
    row: WalletRow,
    claim: WalletClaim,
  ): Effect.fn.Return<OpenStep, StoreFailure> {
    const profile = yield* directory.profile(row);

    return profile.username === claim.username
      ? new Opened({ profile })
      : new AddressBound({ profile });
  });

  const activated = (
    active:
      | Option.Option<Profile>
      | UsernameTaken
      | AddressBound
      | HumanCheckRefused,
  ): OpenStep => {
    if (
      Predicate.isTagged(active, "UsernameTaken") ||
      Predicate.isTagged(active, "AddressBound") ||
      active instanceof HumanCheckRefused
    )
      return active;

    return Option.isSome(active)
      ? new Opened({ profile: active.value })
      : new OpeningPending();
  };

  const activation = Effect.fn("Wallet.activation")(function* (
    row: WalletRow,
    claim: WalletClaim,
    binding: Binding,
  ): Effect.fn.Return<OpenStep, StoreFailure | ChainUnreachable> {
    const attempt = openingAttempt(row);

    const sealed =
      Option.isSome(attempt) && attempt.value instanceof Sealed
        ? Option.some(attempt.value)
        : Option.none<Sealed>();

    const settlement = yield* Option.match(sealed, {
      onNone: () => Effect.succeed(Option.none<Settlement>()),
      onSome: (signed) => Effect.map(chain.settlement(signed), Option.some),
    });

    if (
      Option.isSome(sealed) &&
      Option.exists(settlement, Predicate.isTagged("Undecided")) &&
      !(yield* chain.pastOpeningWindow(sealed.value))
    )
      return new OpeningPending();

    const step = activated(yield* directory.activate(row, claim, binding));

    if (
      Predicate.isTagged(step, "Opened") &&
      Option.isSome(sealed) &&
      Option.exists(settlement, Predicate.isTagged("Applied"))
    )
      yield* Option.match(chain.claimedByOpening(sealed.value, claim.address), {
        onNone: () => Effect.void,
        onSome: transfers.closeUnclaimedFunds,
      });

    return step;
  });

  const lone = (approvals: Approvals): Option.Option<Approval> => {
    const [first, ...rest] = approvals;

    return rest.length === 0 ? Option.some(first) : Option.none();
  };

  const sealDraft = Effect.fn("Wallet.sealDraft")(function* (
    draft: OpeningDraft,
    approvals: Approvals,
    holder: AccountAddress,
  ) {
    const approval = lone(approvals);

    if (Option.isNone(approval)) return Option.none<Sealed>();

    return yield* chain
      .seal(draft.request, approval.value, holder)
      .pipe(Effect.option);
  });

  const draftOpening = Effect.fn("Wallet.draftOpening")(function* (
    address: AccountAddress,
  ) {
    const claim = yield* waitingClaim(address);

    return yield* chain.draftOpening(address, Option.getOrUndefined(claim));
  });

  const openWith = Effect.fn("Wallet.open")(function* (
    claim: WalletClaim,
    approvals: Option.Option<Approvals>,
    binding: Binding,
  ): Effect.fn.Return<OpenStep, StoreFailure | ChainUnreachable> {
    if (!chain.validAddress(claim.address))
      return new InvalidAddress({ address: claim.address });

    const standing = yield* readStanding(claim.address);

    if (standing === "foreign" || standing === "foreignIncomplete")
      return new NotSponsored();

    const availability = yield* directory.available(claim);

    const refused = unavailability(availability);

    if (Option.isSome(refused)) return refused.value;

    const existing = yield* directory.byAddress(claim.address);
    const usable = standing === "open";

    if (Option.isNone(existing)) {
      const drafted = yield* draftOpening(claim.address);
      const written = yield* directory.start(claim.address, drafted);

      if (written.status === "active") return new OpeningPending();

      const stored = openingAttempt(written);

      if (Option.isSome(stored))
        return stored.value instanceof OpeningDraft
          ? stored.value
          : new OpeningPending();

      const redrafted = yield* directory.draft(written, drafted);
      const committed = openingAttempt(redrafted);

      return Option.isSome(committed) && committed.value instanceof OpeningDraft
        ? committed.value
        : new OpeningPending();
    }

    const row = existing.value;

    if (row.status === "active") {
      if (usable) return yield* openedOrBound(row, claim);

      yield* directory.recover(row);

      return new OpeningPending();
    }

    if (usable && (yield* directory.bound(claim)))
      return yield* activation(row, claim, binding);

    const attempt = openingAttempt(row);

    if (Option.isSome(attempt) && attempt.value instanceof Sealed) {
      const settlement = yield* chain.settlement(attempt.value);

      const unfinished = Match.valueTags(settlement, {
        Undecided: () => true,
        Applied: () => false,
        Rejected: () => false,
        Expired: () => false,
      });

      if (Predicate.isTagged(settlement, "Applied"))
        return new OpeningPending();

      const expiredOpening =
        unfinished && (yield* chain.pastOpeningWindow(attempt.value));

      if (unfinished && !expiredOpening) {
        yield* chain.submit(attempt.value).pipe(Effect.ignore);

        return new OpeningPending();
      }

      if (expiredOpening && (yield* readStanding(claim.address)) === "open")
        return yield* activation(row, claim, binding);
    }

    const waiting = yield* waitingClaim(claim.address);

    if (
      Option.isSome(attempt) &&
      attempt.value instanceof OpeningDraft &&
      (yield* live(attempt.value.request)) &&
      (Option.isSome(approvals) ||
        chain.openingDraftClaims(attempt.value.request, waiting))
    ) {
      const pending = attempt.value;

      if (Option.isNone(approvals)) return pending;

      const sealed = yield* sealDraft(pending, approvals.value, claim.address);

      if (Option.isNone(sealed)) return pending;

      const written = yield* directory.seal(row, sealed.value, claim, binding);

      if (
        Predicate.isTagged(written, "UsernameTaken") ||
        Predicate.isTagged(written, "AddressBound") ||
        written instanceof HumanCheckRefused
      )
        return written;

      const committed = openingAttempt(written);

      if (Option.isSome(committed) && committed.value instanceof Sealed)
        yield* chain.submit(committed.value).pipe(Effect.ignore);

      return new OpeningPending();
    }

    const drafted = yield* draftOpening(claim.address);
    const written = yield* directory.draft(row, drafted);
    const stored = openingAttempt(written);

    return Option.isSome(stored) && stored.value instanceof OpeningDraft
      ? stored.value
      : new OpeningPending();
  });

  const open = (
    claim: WalletClaim,
    approvals: Option.Option<Approvals>,
    token: Option.Option<HumanCheckToken>,
  ) => openWith(claim, approvals, checkedBinding(humanCheck.verify(token)));

  const resume = (profile: Profile) =>
    openWith(
      new WalletClaim(profile),
      Option.none(),
      checkedBinding(Effect.succeed(Option.none())),
    );

  return { open, openWith, resume };
});
