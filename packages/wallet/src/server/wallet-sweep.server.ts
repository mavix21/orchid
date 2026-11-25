import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress, type BalanceId } from "../contract";
import {
  type AssetAuthorized,
  type AssetConcluded,
  AssetOrders,
} from "./AssetOrders.server";
import { Chain, type ChainUnreachable, Sealed } from "./Chain.server";
import {
  Directory,
  type StoreFailure,
  type WalletRow,
} from "./Directory.server";
import { sweepTimeBudget } from "../stellar/network";
import { rpcReadConcurrency } from "./settings.server";
import { type Authorized, Transfers } from "./Transfers.server";
import { confirmedReads } from "./wallet-reads.server";

export const sweepFlow = (actions: {
  readonly reconcileTransfer: (
    entry: Authorized,
  ) => Effect.Effect<boolean, StoreFailure | ChainUnreachable>;
  readonly reconcileAsset: (
    entry: AssetAuthorized,
  ) => Effect.Effect<boolean, StoreFailure | ChainUnreachable>;
  readonly closeGoneBalance: (
    id: BalanceId,
  ) => Effect.Effect<void, StoreFailure | ChainUnreachable>;
  readonly cleanUpReceivedLink: (
    concluded: AssetConcluded,
  ) => Effect.Effect<boolean, StoreFailure | ChainUnreachable>;
}) =>
  Effect.gen(function* () {
    const chain = yield* Chain;
    const directory = yield* Directory;
    const transfers = yield* Transfers;
    const assets = yield* AssetOrders;
    const { readAccount } = yield* confirmedReads;

    const recoverWallet = Effect.fn("Wallet.recoverWallet")(function* (
      row: WalletRow,
    ) {
      const address = Schema.decodeSync(AccountAddress)(row.address);
      const current = yield* readAccount(address);

      if (Option.isNone(current) || Option.isNone(current.value.balance)) {
        yield* directory.recover(row);

        return;
      }

      if (
        !row.recoveryEnvelope ||
        !row.recoveryHash ||
        !row.recoveryMaxTime ||
        !row.recoveryMinTime
      )
        return;

      const sealed = new Sealed({
        envelope: row.recoveryEnvelope,
        hash: row.recoveryHash,
        expiresAt: DateTime.makeUnsafe(row.recoveryMaxTime),
      });

      const evidence = yield* chain.settlement(sealed);

      const merged = Match.valueTags(evidence, {
        Applied: () => true,
        Rejected: () => false,
        Expired: () => false,
        Undecided: () => false,
      });

      if (merged) {
        yield* directory.recover(row);

        return;
      }

      const undecided = Match.valueTags(evidence, {
        Undecided: () => true,
        Applied: () => false,
        Rejected: () => false,
        Expired: () => false,
      });

      const now = yield* Clock.currentTimeMillis;

      if (
        undecided &&
        row.recoveryMinTime.getTime() <= now &&
        row.recoveryMaxTime.getTime() > now &&
        current.value.sponsored &&
        current.value.balance.value === 0n &&
        current.value.nativeBalance === 0n &&
        BigInt(current.value.sequence) + 1n ===
          BigInt(row.recoverySequence ?? "0")
      )
        yield* chain.submit(sealed).pipe(Effect.ignore);
    });

    const goneBalanceIds = Effect.gen(function* () {
      const balanceIds = yield* transfers.balancesToCheck;
      const entries = yield* chain.claimable(balanceIds);

      return balanceIds.filter(
        (id) => !entries.some((entry) => entry.balance === id),
      );
    });

    const settleStuckRecords = (runStartedAt: DateTime.Utc) =>
      Effect.gen(function* () {
        const inFlight = yield* transfers.inFlight(runStartedAt);
        const assetOrders = yield* assets.inFlight(runStartedAt);
        const receivedLinks = yield* assets.receivedLinksToClean(runStartedAt);

        const records = yield* Effect.forEach(
          [
            ...assetOrders.map((entry) =>
              actions.reconcileAsset(entry).pipe(Effect.asVoid),
            ),
            ...inFlight.map((entry) =>
              actions.reconcileTransfer(entry).pipe(Effect.asVoid),
            ),
            ...receivedLinks.map((entry) =>
              actions.cleanUpReceivedLink(entry).pipe(Effect.asVoid),
            ),
          ],
          (program) => program.pipe(Effect.exit),
          { concurrency: rpcReadConcurrency },
        );

        return {
          picked: records.length,
          failed: records.flatMap((exit) =>
            Exit.isFailure(exit) ? [exit.cause] : [],
          ),
        };
      });

    const drainStuckRecords = Effect.fn("Wallet.drainStuckRecords")(function* (
      runStartedAt: DateTime.Utc,
    ) {
      const budgetEndsAt = DateTime.add(runStartedAt, {
        seconds: sweepTimeBudget,
      });

      const failed: Array<Cause.Cause<StoreFailure | ChainUnreachable>> = [];

      while (true) {
        const round = yield* settleStuckRecords(runStartedAt);

        failed.push(...round.failed);

        if (round.picked === 0) break;

        if (DateTime.isGreaterThan(yield* DateTime.now, budgetEndsAt)) {
          yield* Effect.logWarning("Sweep stopped at its time budget");

          break;
        }
      }

      return failed;
    });

    return Effect.gen(function* () {
      const runStartedAt = yield* DateTime.now;

      const pruned = yield* transfers.pruneExpiredDrafts.pipe(
        Effect.andThen(assets.pruneExpiredDrafts),
        Effect.andThen(directory.pruneAbandonedOpenings),
        Effect.exit,
      );

      const balanceExits = yield* goneBalanceIds.pipe(
        Effect.flatMap((ids) =>
          Effect.forEach(
            ids,
            (id) => actions.closeGoneBalance(id).pipe(Effect.exit),
            { concurrency: rpcReadConcurrency },
          ),
        ),
        Effect.exit,
      );

      const wallets = yield* directory.recoverable;

      const recoveries = yield* Effect.forEach(
        wallets,
        (row) => recoverWallet(row).pipe(Effect.exit),
        { concurrency: rpcReadConcurrency },
      );

      const drained = yield* drainStuckRecords(runStartedAt).pipe(Effect.exit);

      const failed = [
        ...(Exit.isFailure(pruned) ? [pruned.cause] : []),
        ...(Exit.isFailure(balanceExits)
          ? [balanceExits.cause]
          : balanceExits.value.flatMap((exit) =>
              Exit.isFailure(exit) ? [exit.cause] : [],
            )),
        ...recoveries.flatMap((exit) =>
          Exit.isFailure(exit) ? [exit.cause] : [],
        ),
        ...(Exit.isFailure(drained) ? [drained.cause] : drained.value),
      ];

      yield* Effect.forEach(failed, (cause) =>
        Effect.logError("Sweep record failed", Cause.pretty(cause)),
      );

      if (failed.length > 0)
        return yield* Effect.die(
          new Error(`${failed.length} sweep records could not be reconciled`),
        );
    });
  });
