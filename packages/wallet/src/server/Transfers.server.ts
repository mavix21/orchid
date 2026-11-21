import { balancesToCheck } from "./balance-sweep.server";
import { openBalancesFor, openPaymentLinksFor } from "./open-claimables.server";
import { Database } from "@workspace/db";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  type BalanceId,
  Profile,
  type ResolvedRecipient,
  type SigningRequest,
  type TransferId,
  type TransferOrder,
} from "../contract";
import { claimableBalanceOf } from "../stellar/asset-envelopes";
import {
  approvalMargin,
  epochAt,
  claimableQuota,
  network,
  sweepBatchSize,
} from "../stellar/network";
import { Applied, Expired, Rejected, Sealed } from "./Chain.server";
import { StoreFailure } from "./Directory.server";
import { SlotOccupied, walletLock } from "./slot.server";
import { assetOrders, transfers } from "./tables.server";
import {
  AttemptsJson,
  type Authorized,
  ClaimableKind,
  ClaimablesFull,
  type Concluded,
  type ConclusionColumns,
  OpenBalance,
  OpenLinkRecord,
  OrderJson,
  type Proposed,
  RecipientJson,
  SlotTaken,
  type Transfer,
  type TransferRow,
  appendAttempt,
  claimableKindOf,
  readTransferRow,
} from "./transfer-records.server";

export {
  Authorized,
  ClaimableKind,
  ClaimablesFull,
  Concluded,
  OpenBalance,
  OpenLinkRecord,
  OrderJson,
  Proposed,
  SlotTaken,
  type Transfer,
  pending,
} from "./transfer-records.server";

export class Transfers extends Context.Service<
  Transfers,
  {
    find(id: TransferId): Effect.Effect<Option.Option<Transfer>, StoreFailure>;
    latestFrom(
      sender: AccountAddress,
    ): Effect.Effect<Option.Option<Transfer>, StoreFailure>;
    propose(
      order: TransferOrder,
      recipient: ResolvedRecipient,
      request: SigningRequest,
    ): Effect.Effect<Transfer, StoreFailure>;
    redraft(
      proposed: Proposed,
      request: SigningRequest,
    ): Effect.Effect<Transfer, StoreFailure>;
    authorize(
      proposed: Proposed,
      sealed: Sealed,
    ): Effect.Effect<
      Transfer | SlotTaken | SlotOccupied | ClaimablesFull,
      StoreFailure
    >;
    conclude(
      id: TransferId,
      settlement: Applied | Rejected | Expired,
    ): Effect.Effect<Concluded, StoreFailure>;
    readonly inFlight: Effect.Effect<ReadonlyArray<Authorized>, StoreFailure>;

    readonly balancesToCheck: Effect.Effect<
      ReadonlyArray<BalanceId>,
      StoreFailure
    >;
    openClaimables(
      sender: AccountAddress,
      kind?: ClaimableKind,
    ): Effect.Effect<number, StoreFailure>;

    openBalances(
      address: AccountAddress,
    ): Effect.Effect<ReadonlyArray<OpenBalance>, StoreFailure>;

    openPaymentLinks(
      sender: AccountAddress,
    ): Effect.Effect<ReadonlyArray<OpenLinkRecord>, StoreFailure>;

    closeBalance(balance: BalanceId): Effect.Effect<void, StoreFailure>;
  }
>()("@workspace/wallet/server/Transfers") {
  static readonly layer = Layer.effect(
    Transfers,
    Effect.gen(function* () {
      const db = yield* Database;

      const scopeAt = (now: number) =>
        and(
          eq(transfers.network, network),
          eq(transfers.testnetEpoch, epochAt(now)),
        );

      const decode = (row: TransferRow) =>
        Effect.try({
          try: () => readTransferRow(row),
          catch: (cause) => new StoreFailure({ cause }),
        });

      const unclaimedAt = (now: number) =>
        and(
          scopeAt(now),
          isNotNull(transfers.balanceId),
          isNull(transfers.balanceClosedAt),
        );

      const openFromAt = (
        sender: AccountAddress,
        kind: ClaimableKind,
        now: number,
      ) =>
        and(
          unclaimedAt(now),
          eq(transfers.sender, sender),
          kind === "username"
            ? or(
                eq(transfers.claimableKind, "username"),
                isNull(transfers.claimableKind),
              )
            : eq(transfers.claimableKind, "paymentLink"),
          inArray(transfers.status, ["authorized", "settled"]),
        );

      const find = Effect.fn("Transfers.find")(function* (id: TransferId) {
        const now = yield* Clock.currentTimeMillis;

        const rows = yield* db
          .select()
          .from(transfers)
          .where(and(scopeAt(now), eq(transfers.id, id)));

        return rows[0] ? Option.some(yield* decode(rows[0])) : Option.none();
      });

      const latest = Effect.fn("Transfers.latestFrom")(function* (
        sender: AccountAddress,
      ) {
        const now = yield* Clock.currentTimeMillis;

        const rows = yield* db
          .select()
          .from(transfers)
          .where(
            and(
              scopeAt(now),
              eq(transfers.sender, sender),
              inArray(transfers.status, ["authorized", "settled", "failed"]),
            ),
          )
          .orderBy(
            desc(sql`${transfers.status} = 'authorized'`),
            desc(transfers.createdAt),
          )
          .limit(1);

        return rows[0] ? Option.some(yield* decode(rows[0])) : Option.none();
      });

      const propose = Effect.fn("Transfers.propose")(function* (
        order: TransferOrder,
        recipient: ResolvedRecipient,
        request: SigningRequest,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const balance = claimableBalanceOf(request.envelope);
        const balanceId = Option.getOrNull(balance);
        const claimableKind = claimableKindOf(order, balance);

        const singleAttempt = Option.map(balance, (id) =>
          Schema.encodeSync(AttemptsJson)([id]),
        );

        const value = {
          id: order.id,
          sender: order.from,
          recipient: recipient instanceof Profile ? recipient.address : null,
          destination: recipient.address,
          order: Schema.encodeSync(OrderJson)(order),
          resolvedRecipient: Schema.encodeSync(RecipientJson)(recipient),
          amount: order.amount,
          network,
          testnetEpoch: epochAt(now),
          envelope: request.envelope,
          expiresAt: DateTime.toDateUtc(request.expiresAt),
          balanceId,
          claimableKind,
          attemptBalanceIds: Option.getOrNull(singleAttempt),
        };

        const rows = yield* db
          .insert(transfers)
          .values({ ...value, status: "proposed" })
          .onConflictDoUpdate({
            target: transfers.id,
            set: {
              envelope: request.envelope,
              expiresAt: value.expiresAt,
              balanceId: value.balanceId,
              claimableKind: value.claimableKind,
              attemptBalanceIds: Option.match(singleAttempt, {
                onNone: () => transfers.attemptBalanceIds,
                onSome: (encoded) =>
                  sql`case when ${transfers.attemptBalanceIds} is null then ${encoded} when (${transfers.attemptBalanceIds})::jsonb @> (${encoded})::jsonb then ${transfers.attemptBalanceIds} else ((${transfers.attemptBalanceIds})::jsonb || (${encoded})::jsonb)::text end`,
              }),
            },
            setWhere: and(
              scopeAt(now),
              eq(transfers.status, "proposed"),
              eq(transfers.order, value.order),
              lt(
                transfers.expiresAt,
                DateTime.toDateUtc(
                  DateTime.makeUnsafe(now + approvalMargin * 1000),
                ),
              ),
            ),
          })
          .returning();

        if (rows[0]) return yield* decode(rows[0]);

        const existing = yield* find(order.id);

        if (Option.isNone(existing))
          return yield* new StoreFailure({
            cause: new Error("Transfer id belongs to another network epoch"),
          });

        return existing.value;
      });

      const redraft = Effect.fn("Transfers.redraft")(function* (
        proposed: Proposed,
        request: SigningRequest,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const balance = claimableBalanceOf(request.envelope);
        const attempts = appendAttempt(proposed.attemptBalances, balance);

        const rows = yield* db
          .update(transfers)
          .set({
            envelope: request.envelope,
            expiresAt: DateTime.toDateUtc(request.expiresAt),
            balanceId: Option.getOrNull(balance),
            claimableKind: claimableKindOf(proposed.order, balance),
            attemptBalanceIds:
              attempts.length > 0
                ? Schema.encodeSync(AttemptsJson)(attempts)
                : null,
          })
          .where(
            and(
              scopeAt(now),
              eq(transfers.id, proposed.order.id),
              eq(transfers.status, "proposed"),
              eq(transfers.envelope, proposed.request.envelope),
            ),
          )
          .returning();

        if (rows[0]) return yield* decode(rows[0]);

        const existing = yield* find(proposed.order.id);

        if (Option.isNone(existing))
          return yield* new StoreFailure({
            cause: new Error("Transfer disappeared during redraft"),
          });

        return existing.value;
      });

      const authorize = (proposed: Proposed, sealed: Sealed) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            const id = proposed.order.id;
            const request = proposed.request;

            yield* tx.execute(walletLock(proposed.order.from));

            const lockedAt = yield* Clock.currentTimeMillis;
            const scope = scopeAt(lockedAt);

            const held = yield* tx
              .select()
              .from(transfers)
              .where(
                and(
                  scope,
                  eq(transfers.sender, proposed.order.from),
                  eq(transfers.status, "authorized"),
                ),
              );

            if (held[0] && held[0].id !== id) {
              const holder = yield* decode(held[0]);

              if (Predicate.isTagged(holder, "Authorized"))
                return new SlotTaken({ holder });
            }

            const elsewhere = yield* tx
              .select({ id: assetOrders.id })
              .from(assetOrders)
              .where(
                and(
                  eq(assetOrders.network, network),
                  eq(assetOrders.testnetEpoch, epochAt(lockedAt)),
                  eq(assetOrders.wallet, proposed.order.from),
                  eq(assetOrders.status, "authorized"),
                ),
              );

            if (elsewhere[0]) return new SlotOccupied();

            if (proposed.claimable) {
              const kind = proposed.claimableKind ?? "username";
              const limit = claimableQuota[kind];

              const open = yield* tx
                .select({ total: count() })
                .from(transfers)
                .where(openFromAt(proposed.order.from, kind, lockedAt));

              if ((open[0]?.total ?? 0) >= limit)
                return new ClaimablesFull({ limit });
            }

            const commitAt = yield* Clock.currentTimeMillis;

            const written = yield* tx
              .update(transfers)
              .set({
                status: "authorized",
                envelope: sealed.envelope,
                hash: sealed.hash,
              })
              .where(
                and(
                  scope,
                  eq(transfers.id, id),
                  eq(transfers.status, "proposed"),
                  eq(transfers.envelope, request.envelope),
                  gt(
                    transfers.expiresAt,
                    DateTime.toDateUtc(
                      DateTime.makeUnsafe(commitAt + approvalMargin * 1000),
                    ),
                  ),
                ),
              )
              .returning();

            if (written[0]) return yield* decode(written[0]);

            const fresh = yield* tx
              .select()
              .from(transfers)
              .where(and(scope, eq(transfers.id, id)));

            if (!fresh[0])
              return yield* new StoreFailure({
                cause: new Error("Transfer disappeared"),
              });

            return yield* decode(fresh[0]);
          }),
        );

      const conclude = Effect.fn("Transfers.conclude")(function* (
        id: TransferId,
        settlement: Applied | Rejected | Expired,
      ) {
        const now = yield* DateTime.now;
        const nowDate = DateTime.toDateUtc(now);

        const values = Match.valueTags(settlement, {
          Applied: (applied): ConclusionColumns => ({
            status: "settled",
            concludedAt: DateTime.toDateUtc(applied.at),
            failure: null,
          }),
          Rejected: (): ConclusionColumns => ({
            status: "failed",
            concludedAt: nowDate,
            failure: "rejected",
          }),
          Expired: (): ConclusionColumns => ({
            status: "failed",
            concludedAt: nowDate,
            failure: "expired",
          }),
        });

        const rows = yield* db
          .update(transfers)
          .set(values)
          .where(
            and(
              scopeAt(DateTime.toEpochMillis(now)),
              eq(transfers.id, id),
              eq(transfers.status, "authorized"),
            ),
          )
          .returning();

        const current = rows[0]
          ? yield* decode(rows[0])
          : Option.getOrUndefined(yield* find(id));

        if (!Predicate.isTagged(current, "Concluded"))
          return yield* new StoreFailure({
            cause: new Error("Transfer is not concluded"),
          });

        return current;
      });

      const wrap = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(Effect.mapError((cause) => new StoreFailure({ cause })));

      const inFlight = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const scope = scopeAt(DateTime.toEpochMillis(now));

        const rows = yield* db
          .update(transfers)
          .set({ sweepCheckedAt: DateTime.toDateUtc(now) })
          .where(
            and(
              scope,
              eq(transfers.status, "authorized"),
              inArray(
                transfers.id,
                db
                  .select({ id: transfers.id })
                  .from(transfers)
                  .where(and(scope, eq(transfers.status, "authorized")))
                  .orderBy(
                    sql`${transfers.sweepCheckedAt} asc nulls first`,
                    transfers.id,
                  )
                  .limit(sweepBatchSize),
              ),
            ),
          )
          .returning();

        return yield* Effect.forEach(rows, (row) =>
          decode(row).pipe(
            Effect.flatMap((transfer) =>
              Predicate.isTagged(transfer, "Authorized")
                ? Effect.succeed(transfer)
                : Effect.fail(
                    new StoreFailure({
                      cause: new Error("Invalid in-flight state"),
                    }),
                  ),
            ),
          ),
        );
      });

      return Transfers.of({
        find: (id) => wrap(find(id)),
        latestFrom: (sender) => wrap(latest(sender)),
        propose: (order, recipient, request) =>
          wrap(propose(order, recipient, request)),
        redraft: (proposed, request) => wrap(redraft(proposed, request)),
        authorize: (proposed, sealed) => wrap(authorize(proposed, sealed)),
        conclude: (id, settlement) => wrap(conclude(id, settlement)),
        inFlight: wrap(inFlight),
        balancesToCheck: wrap(
          balancesToCheck.pipe(Effect.provideService(Database, db)),
        ),
        openClaimables: (sender, kind = "username") =>
          wrap(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                db
                  .select({ total: count() })
                  .from(transfers)
                  .where(openFromAt(sender, kind, now)),
              ),
              Effect.map((rows) => rows[0]?.total ?? 0),
            ),
          ),
        openBalances: (address) =>
          wrap(
            openBalancesFor(address).pipe(Effect.provideService(Database, db)),
          ),
        openPaymentLinks: (sender) =>
          wrap(
            openPaymentLinksFor(sender).pipe(
              Effect.provideService(Database, db),
            ),
          ),
        closeBalance: (balance) =>
          wrap(
            DateTime.now.pipe(
              Effect.flatMap((now) =>
                db
                  .update(transfers)
                  .set({ balanceClosedAt: DateTime.toDateUtc(now) })
                  .where(
                    and(
                      unclaimedAt(DateTime.toEpochMillis(now)),
                      eq(transfers.status, "settled"),
                      eq(transfers.balanceId, balance),
                    ),
                  ),
              ),
              Effect.asVoid,
            ),
          ),
      });
    }),
  );
}
