import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress, type BalanceId } from "../contract";
import { AssetOrders, type AssetAuthorized } from "./AssetOrders.server";
import { Chain, type ChainUnreachable, Sealed } from "./Chain.server";
import {
  Directory,
  type StoreFailure,
  type WalletRow,
} from "./Directory.server";
import { rpcReadConcurrency } from "./settings.server";
import { type Authorized, Transfers } from "./Transfers.server";
import { confirmedReads } from "./wallet-reads.server";

export const sweepFlow = (actions: {
  readonly reconcileTransfer: (
    entry: Authorized,
  ) => Effect.Effect<void, StoreFailure | ChainUnreachable>;
  readonly reconcileAsset: (
    entry: AssetAuthorized,
  ) => Effect.Effect<void, StoreFailure | ChainUnreachable>;
  readonly closeGoneBalance: (
    id: BalanceId,
  ) => Effect.Effect<void, StoreFailure | ChainUnreachable>;
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

    return Effect.gen(function* () {
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

      const inFlight = yield* transfers.inFlight;
      const wallets = yield* directory.recoverable;
      const assetOrders = yield* assets.inFlight;

      const records = yield* Effect.forEach(
        [
          ...assetOrders.map((entry) =>
            actions.reconcileAsset(entry).pipe(Effect.asVoid),
          ),
          ...inFlight.map((entry) =>
            actions.reconcileTransfer(entry).pipe(Effect.asVoid),
          ),
          ...wallets.map(recoverWallet),
        ],
        (program) => program.pipe(Effect.exit),
      );

      const failed = [
        ...(Exit.isFailure(balanceExits)
          ? [balanceExits.cause]
          : balanceExits.value.flatMap((exit) =>
              Exit.isFailure(exit) ? [exit.cause] : [],
            )),
        ...records.flatMap((exit) =>
          Exit.isFailure(exit) ? [exit.cause] : [],
        ),
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
