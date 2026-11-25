import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressBound,
  type Approval,
  type Approvals,
  type BalanceId,
  HumanCheckRefused,
  type HumanCheckToken,
  InvalidAddress,
  NotSponsored,
  Opened,
  OpeningDraft,
  OpeningPending,
  OpenStep,
  Profile,
  RecoveryDraft,
  SigningRequest,
  UsernameTaken,
  WalletClaim,
  assetKey,
  baseAsset,
} from "../contract";
import { claimedByOpening, readEnvelope } from "../stellar/envelopes";
import { recoveryDelay, recoveryDraftLifetime } from "../stellar/network";
import {
  type AccountState,
  Chain,
  ChainUnreachable,
  Sealed,
} from "./Chain.server";
import { Directory, StoreFailure, type WalletRow } from "./Directory.server";
import { claimableAt } from "./ledger-assets.server";
import { Transfers } from "./Transfers.server";
import {
  type Binding,
  checkedBinding,
  unavailability,
} from "./username-standing.server";
import { HumanCheck } from "./HumanCheck.server";
import { openingAttempt, pairedRecovery } from "./opening-attempt.server";
import { SignedWorkInFlight } from "./slot.server";
import { confirmedReads, live } from "./wallet-reads.server";

export const openingFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const directory = yield* Directory;
  const humanCheck = yield* HumanCheck;
  const transfers = yield* Transfers;
  const { readAccount } = yield* confirmedReads;

  const waitingClaim = Effect.fn("Wallet.waitingClaim")(function* (
    address: AccountAddress,
  ): Effect.fn.Return<
    Option.Option<BalanceId>,
    StoreFailure | ChainUnreachable
  > {
    const waiting = yield* transfers.waitingBalances(address);

    if (waiting.length === 0) return Option.none();

    const entries = yield* chain.claimable(waiting);
    const now = BigInt(Math.floor((yield* Clock.currentTimeMillis) / 1000));

    return Option.fromNullishOr(
      waiting.find((balance) =>
        entries.some(
          (entry) =>
            entry.balance === balance &&
            assetKey(entry.asset) === assetKey(baseAsset) &&
            entry.claimants.some(
              (claimant) =>
                claimant.destination === address &&
                claimableAt(claimant.predicate, now),
            ),
        ),
      ),
    );
  });

  const carriesClaim = (draft: OpeningDraft, claim: Option.Option<BalanceId>) =>
    Option.exists(
      readEnvelope(draft.request.envelope),
      (facts) =>
        Predicate.isTagged(facts, "OpeningFacts") &&
        facts.claim === Option.getOrUndefined(claim),
    );

  const openedOrBound = Effect.fn("Wallet.openedOrBound")(function* (
    row: WalletRow,
    claim: WalletClaim,
  ): Effect.fn.Return<OpenStep, StoreFailure> {
    const profile = yield* directory.profile(row);

    return profile.username === claim.username
      ? new Opened({ profile })
      : new AddressBound({ profile });
  });

  const saveRecoveryDraft = Effect.fn("Wallet.saveRecoveryDraft")(function* (
    row: WalletRow,
    request: SigningRequest,
    claim: WalletClaim,
  ): Effect.fn.Return<OpenStep, StoreFailure> {
    const written = yield* directory.recoveryDraft(row, request);

    if (written.status === "active")
      return yield* openedOrBound(written, claim);

    if (!written.recoveryDraft || !written.recoveryMaxTime)
      return new OpeningPending();

    return new RecoveryDraft({
      request: new SigningRequest({
        envelope: Schema.decodeSync(SigningRequest.fields.envelope)(
          written.recoveryDraft,
        ),
        expiresAt: DateTime.makeUnsafe(written.recoveryMaxTime),
      }),
    });
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

  const pairedActivation = Effect.fn("Wallet.pairedActivation")(function* (
    row: WalletRow,
    state: AccountState,
    claim: WalletClaim,
    binding: Binding,
  ): Effect.fn.Return<
    Option.Option<OpenStep>,
    StoreFailure | ChainUnreachable
  > {
    const paired = pairedRecovery(row);
    const attempt = openingAttempt(row);

    if (
      Option.isNone(paired) ||
      Option.isNone(attempt) ||
      !(attempt.value instanceof Sealed)
    )
      return Option.none();

    const facts = readEnvelope(paired.value.request.envelope);

    if (
      Option.isNone(facts) ||
      !Predicate.isTagged(facts.value, "RecoveryFacts") ||
      BigInt(facts.value.sequence) !== BigInt(state.sequence) + 1n ||
      !(yield* live(paired.value.request))
    )
      return Option.none();

    const settlement = yield* chain.settlement(attempt.value);

    if (
      Predicate.isTagged(settlement, "Undecided") &&
      !(yield* chain.pastOpeningWindow(attempt.value))
    )
      return Option.some(new OpeningPending());

    if (!Predicate.isTagged(settlement, "Applied")) return Option.none();

    const fresh = yield* readAccount(
      Schema.decodeSync(AccountAddress)(row.address),
    );

    if (
      Option.isNone(fresh) ||
      fresh.value.sequence !== state.sequence ||
      Option.isNone(fresh.value.balance) ||
      !fresh.value.sponsored
    )
      return Option.some(new OpeningPending());

    const step = activated(
      yield* directory.activatePaired(row, facts.value, claim, binding),
    );

    if (Predicate.isTagged(step, "Opened"))
      yield* Option.match(
        claimedByOpening(attempt.value.envelope, claim.address),
        {
          onNone: () => Effect.void,
          onSome: transfers.closeBalance,
        },
      );

    return Option.some(step);
  });

  const lone = (approvals: Option.Option<Approvals>): Option.Option<Approval> =>
    Option.flatMap(approvals, ([first, ...rest]) =>
      rest.length === 0 ? Option.some(first) : Option.none(),
    );

  const recoveryStage = Effect.fn("Wallet.recoveryStage")(function* (
    row: WalletRow,
    state: AccountState,
    approvals: Option.Option<Approvals>,
    claim: WalletClaim,
    binding: Binding,
    pairedAllowed: boolean,
  ): Effect.fn.Return<OpenStep, StoreFailure | ChainUnreachable> {
    const address = Schema.decodeSync(AccountAddress)(row.address);

    if (!state.sponsored) return new NotSponsored();

    if (pairedAllowed) {
      const paired = yield* pairedActivation(row, state, claim, binding);

      if (Option.isSome(paired)) return paired.value;
    }

    const stored =
      row.recoveryDraft && row.recoveryMaxTime
        ? new SigningRequest({
            envelope: Schema.decodeSync(SigningRequest.fields.envelope)(
              row.recoveryDraft,
            ),
            expiresAt: DateTime.makeUnsafe(row.recoveryMaxTime),
          })
        : undefined;

    const facts = stored ? readEnvelope(stored.envelope) : Option.none();
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    if (
      !stored ||
      !(yield* live(stored)) ||
      Option.isNone(facts) ||
      !Predicate.isTagged(facts.value, "RecoveryFacts") ||
      facts.value.minLedger !== undefined ||
      facts.value.minTime < now + recoveryDelay - recoveryDraftLifetime ||
      BigInt(facts.value.sequence) !== BigInt(state.sequence) + 1n
    ) {
      const request = yield* chain.draftRecovery(address);

      return yield* saveRecoveryDraft(row, request, claim);
    }

    const approval = lone(approvals);

    if (Option.isNone(approval)) return new RecoveryDraft({ request: stored });

    const sealed = yield* chain
      .seal(stored, approval.value, address)
      .pipe(Effect.option);

    if (Option.isNone(sealed)) return new RecoveryDraft({ request: stored });

    const fresh = yield* readAccount(address);

    if (
      Option.isNone(fresh) ||
      fresh.value.sequence !== state.sequence ||
      Option.isNone(fresh.value.balance) ||
      !fresh.value.sponsored
    )
      return new OpeningPending();

    return activated(
      yield* directory.activate(row, sealed.value, facts.value, claim, binding),
    );
  });

  const sealDraft = Effect.fn("Wallet.sealDraft")(function* (
    draft: OpeningDraft,
    approvals: Approvals,
    holder: AccountAddress,
  ) {
    const [openingApproval, recoveryApproval] = approvals;

    if (approvals.length !== (draft.recovery ? 2 : 1))
      return Option.none<{
        readonly opening: Sealed;
        readonly recovery: Option.Option<Sealed>;
      }>();

    const opening = yield* chain
      .seal(draft.request, openingApproval, holder)
      .pipe(Effect.option);

    if (Option.isNone(opening)) return Option.none();

    if (draft.recovery === undefined || recoveryApproval === undefined)
      return Option.some({
        opening: opening.value,
        recovery: Option.none<Sealed>(),
      });

    const recovery = yield* chain
      .seal(draft.recovery, recoveryApproval, holder)
      .pipe(Effect.option);

    return Option.map(recovery, (signed) => ({
      opening: opening.value,
      recovery: Option.some(signed),
    }));
  });

  const draftOpening = Effect.fn("Wallet.draftOpening")(function* (
    address: AccountAddress,
    state: Option.Option<AccountState>,
  ) {
    const pinSequence =
      Option.isNone(state) || !(yield* directory.hasSignedWork(address));

    const claim = yield* waitingClaim(address);

    return yield* chain.draftOpening(
      address,
      pinSequence,
      Option.getOrUndefined(claim),
    );
  });

  const openWith = Effect.fn("Wallet.open")(function* (
    claim: WalletClaim,
    approvals: Option.Option<Approvals>,
    binding: Binding,
  ): Effect.fn.Return<OpenStep, StoreFailure | ChainUnreachable> {
    if (!chain.validAddress(claim.address))
      return new InvalidAddress({ address: claim.address });

    const state = yield* readAccount(claim.address);

    if (Option.isSome(state) && !state.value.accountSponsored)
      return new NotSponsored();

    const availability = yield* directory.available(claim);

    const refused = unavailability(availability);

    if (Option.isSome(refused)) return refused.value;

    const existing = yield* directory.byAddress(claim.address);
    const usable = Option.isSome(state) && Option.isSome(state.value.balance);

    if (Option.isNone(existing)) {
      if (usable && Option.isSome(state)) {
        if (!state.value.sponsored) return new NotSponsored();

        const request = yield* chain.draftRecovery(claim.address);
        const row = yield* directory.start(claim.address);

        if (row.status === "active") return yield* openedOrBound(row, claim);

        return row.recoveryDraft && row.recoveryMaxTime
          ? yield* recoveryStage(
              row,
              state.value,
              approvals,
              claim,
              binding,
              false,
            )
          : yield* saveRecoveryDraft(row, request, claim);
      }

      const drafted = yield* draftOpening(claim.address, state);
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

    if (usable && Option.isSome(state))
      return yield* recoveryStage(
        row,
        state.value,
        approvals,
        claim,
        binding,
        true,
      );

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

      if (expiredOpening) {
        const confirmed = yield* readAccount(claim.address);

        if (Option.isSome(confirmed) && Option.isSome(confirmed.value.balance))
          return yield* recoveryStage(
            row,
            confirmed.value,
            Option.none(),
            claim,
            binding,
            false,
          );
      }
    }

    if (
      Option.isSome(attempt) &&
      attempt.value instanceof OpeningDraft &&
      (yield* live(attempt.value.request)) &&
      (Option.isSome(approvals) ||
        carriesClaim(attempt.value, yield* waitingClaim(claim.address)))
    ) {
      const pending = attempt.value;

      if (Option.isNone(approvals)) return pending;

      const sealed = yield* sealDraft(pending, approvals.value, claim.address);

      if (Option.isNone(sealed)) return pending;

      const written = yield* directory.seal(
        row,
        sealed.value.opening,
        claim,
        sealed.value.recovery,
        Option.isSome(state),
        binding,
      );

      if (written instanceof SignedWorkInFlight) {
        const unpinned = yield* draftOpening(claim.address, state);

        const replaced = openingAttempt(yield* directory.draft(row, unpinned));

        return Option.isSome(replaced) && replaced.value instanceof OpeningDraft
          ? replaced.value
          : new OpeningPending();
      }

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

    const drafted = yield* draftOpening(claim.address, state);
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
