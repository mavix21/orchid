import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AccountAddress } from "../contract";
import {
  depositCatchUpLimit,
  depositCatchUpSpan,
  depositFreshness,
  depositLedgerScan,
  depositPageLimit,
  depositTimeBudget,
} from "../policy";
import { Chain } from "./Chain.server";
import { EventsStart } from "./chain-deposits.server";
import { Deposits } from "./Deposits.server";

export const depositFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const deposits = yield* Deposits;

  const resumeFrom = Effect.fn("Wallet.resumeDepositIngest")(function* () {
    const window = yield* chain.ledgerWindow;
    const stored = yield* deposits.cursor;

    if (
      Option.isSome(stored) &&
      stored.value.ledger >= window.oldestLedger &&
      stored.value.ledger <= window.latestLedger
    )
      return EventsStart.FromCursor({ cursor: stored.value.cursor });

    yield* Effect.logWarning(
      "Deposit ingest restarts at the oldest ledger",
      Option.match(stored, {
        onNone: () => ({
          skippedFrom: "never read",
          oldestLedger: window.oldestLedger,
        }),
        onSome: ({ ledger }) => ({
          skippedFrom: ledger,
          oldestLedger: window.oldestLedger,
        }),
      }),
    );

    return EventsStart.FromLedger({ ledger: window.oldestLedger });
  });

  const ingest = Effect.fn("Wallet.ingestDeposits")(function* () {
    const budgetEndsAt = DateTime.add(yield* DateTime.now, {
      seconds: depositTimeBudget,
    });

    let start = yield* resumeFrom();

    while (true) {
      const page = yield* chain.assetEvents({
        start,
        wallet: Option.none(),
        limit: depositPageLimit,
      });

      yield* deposits.store(
        page.events,
        Option.some({
          cursor: page.cursor,
          ledger: page.cursorLedger,
          closedAt: page.cursorClosedAt,
        }),
      );

      if (page.drained) return;

      if (DateTime.isGreaterThan(yield* DateTime.now, budgetEndsAt)) {
        yield* Effect.logWarning("Deposit ingest stopped at its time budget");

        return;
      }

      start = EventsStart.FromCursor({ cursor: page.cursor });
    }
  });

  const catchUpStart = Effect.fn("Wallet.depositCatchUpStart")(function* (
    stored: Option.Option<{ readonly ledger: number }>,
    sinceCursor: Option.Option<number>,
  ) {
    if (
      Option.isSome(stored) &&
      Option.exists(sinceCursor, (age) => age <= depositCatchUpSpan * 1000)
    )
      return EventsStart.FromLedger({ ledger: stored.value.ledger });

    const window = yield* chain.ledgerWindow;

    return EventsStart.FromLedger({
      ledger: Math.max(
        window.oldestLedger,
        window.latestLedger - (depositLedgerScan - 1),
      ),
    });
  });

  const catchUp = Effect.fn("Wallet.catchUpDeposits")(function* (
    address: AccountAddress,
  ) {
    const stored = yield* deposits.cursor;
    const now = yield* DateTime.now;

    const sinceCursor = Option.flatMap(stored, ({ closedAt }) => closedAt).pipe(
      Option.map(
        (closedAt) =>
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(closedAt),
      ),
    );

    if (Option.exists(sinceCursor, (age) => age <= depositFreshness * 1000))
      return;

    const page = yield* chain.assetEvents({
      start: yield* catchUpStart(stored, sinceCursor),
      wallet: Option.some(address),
      limit: depositCatchUpLimit,
    });

    yield* deposits.store(page.events, Option.none());
  });

  return {
    ingest,
    catchUp: (address: AccountAddress) =>
      catchUp(address).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Deposit catch-up failed", Cause.pretty(cause)),
        ),
      ),
  };
});
