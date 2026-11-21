import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressBound,
  Approval,
  InvalidAddress,
  NotSponsored,
  Opened,
  OpeningDraft,
  OpeningPending,
  OpenStep,
  RecoveryDraft,
  SigningRequest,
  WalletClaim,
} from "../contract";
import { readEnvelope } from "../stellar/envelopes";
import {
  type AccountState,
  Chain,
  ChainUnreachable,
  Sealed,
} from "./Chain.server";
import {
  Directory,
  StoreFailure,
  type WalletRow,
  openingAttempt,
  unavailability,
} from "./Directory.server";
import { confirmedReads, live } from "./wallet-reads.server";

export const openingFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const directory = yield* Directory;
  const { readAccount } = yield* confirmedReads;

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

  const recoveryStage = Effect.fn("Wallet.recoveryStage")(function* (
    row: WalletRow,
    state: AccountState,
    approval: Option.Option<Approval>,
    claim: WalletClaim,
  ): Effect.fn.Return<OpenStep, StoreFailure | ChainUnreachable> {
    const address = Schema.decodeSync(AccountAddress)(row.address);

    if (!state.sponsored) return new NotSponsored();

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

    if (
      !stored ||
      !live(stored) ||
      Option.isNone(facts) ||
      !Predicate.isTagged(facts.value, "RecoveryFacts") ||
      BigInt(facts.value.sequence) !== BigInt(state.sequence) + 1n
    ) {
      const request = yield* chain.draftRecovery(address);

      return yield* saveRecoveryDraft(row, request, claim);
    }

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

    const active = yield* directory.activate(
      row,
      sealed.value,
      facts.value,
      claim,
    );

    if (
      Predicate.isTagged(active, "UsernameTaken") ||
      Predicate.isTagged(active, "AddressBound")
    )
      return active;

    return Option.isSome(active)
      ? new Opened({ profile: active.value })
      : new OpeningPending();
  });

  const open = Effect.fn("Wallet.open")(function* (
    claim: WalletClaim,
    approval: Option.Option<Approval>,
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
          ? yield* recoveryStage(row, state.value, approval, claim)
          : yield* saveRecoveryDraft(row, request, claim);
      }

      const request = yield* chain.draftOpening(claim.address);
      const written = yield* directory.start(claim.address, request);

      if (written.status === "active") return new OpeningPending();

      const stored = openingAttempt(written);

      if (Option.isSome(stored))
        return stored.value instanceof SigningRequest
          ? new OpeningDraft({ request: stored.value })
          : new OpeningPending();

      const drafted = yield* directory.draft(written, request);
      const committed = openingAttempt(drafted);

      return Option.isSome(committed) &&
        committed.value instanceof SigningRequest
        ? new OpeningDraft({ request: committed.value })
        : new OpeningPending();
    }

    const row = existing.value;

    if (row.status === "active") {
      if (usable) return yield* openedOrBound(row, claim);

      yield* directory.recover(row);

      return new OpeningPending();
    }

    if (usable && Option.isSome(state))
      return yield* recoveryStage(row, state.value, approval, claim);

    const attempt = openingAttempt(row);

    if (Option.isSome(attempt) && attempt.value instanceof Sealed) {
      const settlement = yield* chain.settlement(attempt.value);

      const unfinished = Match.valueTags(settlement, {
        Undecided: () => true,
        Applied: () => false,
        Rejected: () => false,
        Expired: () => false,
      });

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
          );
      }
    }

    if (
      Option.isSome(attempt) &&
      attempt.value instanceof SigningRequest &&
      live(attempt.value)
    ) {
      if (Option.isNone(approval))
        return new OpeningDraft({ request: attempt.value });

      const sealed = yield* chain
        .seal(attempt.value, approval.value, claim.address)
        .pipe(Effect.option);

      if (Option.isNone(sealed))
        return new OpeningDraft({ request: attempt.value });

      const written = yield* directory.seal(row, sealed.value, claim);

      if (
        Predicate.isTagged(written, "UsernameTaken") ||
        Predicate.isTagged(written, "AddressBound")
      )
        return written;

      const committed = openingAttempt(written);

      if (Option.isSome(committed) && committed.value instanceof Sealed)
        yield* chain.submit(committed.value).pipe(Effect.ignore);

      return new OpeningPending();
    }

    const request = yield* chain.draftOpening(claim.address);
    const written = yield* directory.draft(row, request);
    const stored = openingAttempt(written);

    return Option.isSome(stored) && stored.value instanceof SigningRequest
      ? new OpeningDraft({ request: stored.value })
      : new OpeningPending();
  });

  return open;
});
