import { makeDatabase } from "@workspace/db";
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
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  BalanceId,
  Failed,
  Pending,
  Profile,
  ResolvedRecipient,
  Settled,
  SigningRequest,
  TransferId,
  TransferOrder,
  Username,
} from "../contract";
import { claimableBalanceOf } from "../stellar/asset-envelopes";
import {
  approvalMargin,
  claimableReadLimit,
  epochAt,
  maxOpenClaimables,
  network,
  sweepBatchSize,
} from "../stellar/network";
import { Applied, Expired, Rejected, Sealed } from "./Chain.server";
import { StoreFailure } from "./Directory.server";
import { SlotOccupied, walletLock } from "./slot.server";
import { assetOrders, transfers, usernames } from "./tables.server";

export class Proposed extends Schema.TaggedClass<Proposed>()("Proposed", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  request: SigningRequest,
  claimable: Schema.optional(BalanceId),
}) {}

export class Authorized extends Schema.TaggedClass<Authorized>()("Authorized", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  sealed: Sealed,
  claimable: Schema.optional(BalanceId),
}) {}

export class Concluded extends Schema.TaggedClass<Concluded>()("Concluded", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  receipt: Schema.Union([Settled, Failed]),
}) {}

export class SlotTaken extends Schema.TaggedClass<SlotTaken>()("SlotTaken", {
  holder: Authorized,
}) {}

/** The sender already has `maxOpenClaimables` unclaimed balances; this one was not stored. */
export class ClaimablesFull extends Schema.TaggedClass<ClaimablesFull>()(
  "ClaimablesFull",
  {},
) {}

/** A settled claimable transfer whose balance has not been seen to leave the ledger. */
export class OpenBalance extends Schema.Class<OpenBalance>("OpenBalance")({
  balance: BalanceId,
  from: Profile,
  to: Profile,
}) {}

export type Transfer = Proposed | Authorized | Concluded;

type TransferRow = typeof transfers.$inferSelect;

interface ConclusionColumns {
  readonly status: "settled" | "failed";
  readonly concludedAt: Date;
  readonly failure: "expired" | "rejected" | null;
}

export const OrderJson = Schema.fromJsonString(TransferOrder);
const RecipientJson = Schema.fromJsonString(ResolvedRecipient);

export function pending(transfer: Authorized): Pending {
  return new Pending({
    ...transfer.order,
    recipient: transfer.recipient,
    claimable: transfer.claimable,
    expiresAt: transfer.sealed.expiresAt,
  });
}

function readRow(row: TransferRow): Transfer {
  const order = Schema.decodeSync(OrderJson)(row.order);
  const recipient = Schema.decodeSync(RecipientJson)(row.resolvedRecipient);
  const expiresAt = DateTime.makeUnsafe(row.expiresAt);

  const claimable =
    row.balanceId === null
      ? undefined
      : Schema.decodeSync(BalanceId)(row.balanceId);

  const fields = { order, recipient, claimable };

  return Match.value(row.status).pipe(
    Match.when(
      "proposed",
      () =>
        new Proposed({
          ...fields,
          request: new SigningRequest({
            envelope: Schema.decodeSync(SigningRequest.fields.envelope)(
              row.envelope,
            ),
            expiresAt,
          }),
        }),
    ),
    Match.when("authorized", () => {
      if (!row.hash) throw new Error("Authorized transfer missing hash");

      return new Authorized({
        ...fields,
        sealed: new Sealed({
          envelope: row.envelope,
          hash: row.hash,
          expiresAt,
        }),
      });
    }),
    Match.when("settled", () => {
      if (!row.concludedAt)
        throw new Error("Settled transfer missing ledger time");

      return new Concluded({
        order,
        recipient,
        receipt: new Settled({
          ...order,
          recipient,
          claimable,
          settledAt: DateTime.makeUnsafe(row.concludedAt),
        }),
      });
    }),
    Match.when("failed", () => {
      if (!row.failure) throw new Error("Failed transfer missing reason");

      return new Concluded({
        order,
        recipient,
        receipt: new Failed({
          ...order,
          recipient,
          claimable,
          reason: row.failure,
        }),
      });
    }),
    Match.exhaustive,
  );
}

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
    /** How many balances the sender created that nobody is known to have claimed. */
    openClaimables(sender: AccountAddress): Effect.Effect<number, StoreFailure>;
    /** Unclaimed balances this wallet sent or was sent, newest first. */
    openBalances(
      address: AccountAddress,
    ): Effect.Effect<ReadonlyArray<OpenBalance>, StoreFailure>;
    /** Records that the balance left the ledger. Callers confirm the absence first. */
    closeBalance(balance: BalanceId): Effect.Effect<void, StoreFailure>;
  }
>()("@workspace/wallet/server/Transfers") {
  static readonly layer = Layer.effect(
    Transfers,
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      const scope = and(
        eq(transfers.network, network),
        eq(transfers.testnetEpoch, epochAt(Date.now())),
      );

      const decode = (row: TransferRow) =>
        Effect.try({
          try: () => readRow(row),
          catch: (cause) => new StoreFailure({ cause }),
        });

      const unclaimed = and(
        scope,
        isNotNull(transfers.balanceId),
        isNull(transfers.balanceClosedAt),
      );

      const openFrom = (sender: AccountAddress) =>
        and(
          unclaimed,
          eq(transfers.sender, sender),
          inArray(transfers.status, ["authorized", "settled"]),
        );

      const openBalances = Effect.fn("Transfers.openBalances")(function* (
        address: AccountAddress,
      ) {
        const rows = yield* db
          .select({
            balance: transfers.balanceId,
            sender: transfers.sender,
            username: usernames.username,
            resolvedRecipient: transfers.resolvedRecipient,
          })
          .from(transfers)
          .innerJoin(usernames, eq(usernames.address, transfers.sender))
          .where(
            and(
              unclaimed,
              eq(transfers.status, "settled"),
              or(
                eq(transfers.sender, address),
                eq(transfers.recipient, address),
              ),
            ),
          )
          .orderBy(desc(transfers.createdAt))
          .limit(claimableReadLimit);

        return yield* Effect.try({
          try: () =>
            rows.flatMap((row) => {
              const to = Schema.decodeSync(RecipientJson)(
                row.resolvedRecipient,
              );

              return to instanceof Profile
                ? [
                    new OpenBalance({
                      balance: Schema.decodeUnknownSync(BalanceId)(row.balance),
                      from: new Profile({
                        address: Schema.decodeSync(AccountAddress)(row.sender),
                        username: Schema.decodeSync(Username)(row.username),
                      }),
                      to,
                    }),
                  ]
                : [];
            }),
          catch: (cause) => new StoreFailure({ cause }),
        });
      });

      const find = Effect.fn("Transfers.find")(function* (id: TransferId) {
        const rows = yield* db
          .select()
          .from(transfers)
          .where(and(scope, eq(transfers.id, id)));

        return rows[0] ? Option.some(yield* decode(rows[0])) : Option.none();
      });

      const latest = Effect.fn("Transfers.latestFrom")(function* (
        sender: AccountAddress,
      ) {
        const rows = yield* db
          .select()
          .from(transfers)
          .where(
            and(
              scope,
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
        const value = {
          id: order.id,
          sender: order.from,
          recipient: recipient instanceof Profile ? recipient.address : null,
          destination: recipient.address,
          order: Schema.encodeSync(OrderJson)(order),
          resolvedRecipient: Schema.encodeSync(RecipientJson)(recipient),
          amount: order.amount,
          network,
          testnetEpoch: epochAt(Date.now()),
          envelope: request.envelope,
          expiresAt: DateTime.toDateUtc(request.expiresAt),
          balanceId: Option.getOrNull(claimableBalanceOf(request.envelope)),
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
            },
            setWhere: and(
              scope,
              eq(transfers.status, "proposed"),
              eq(transfers.order, value.order),
              lt(
                transfers.expiresAt,
                new Date(Date.now() + approvalMargin * 1000),
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
        const rows = yield* db
          .update(transfers)
          .set({
            envelope: request.envelope,
            expiresAt: DateTime.toDateUtc(request.expiresAt),
            // The balance ID is derived from the sequence number, so it follows the draft.
            balanceId: Option.getOrNull(claimableBalanceOf(request.envelope)),
          })
          .where(
            and(
              scope,
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

            // Acquire the sender lock before any row lock, so concurrent approvals
            // cannot deadlock while holding different transfer rows.
            yield* tx.execute(walletLock(proposed.order.from));

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

              if (holder instanceof Authorized)
                return new SlotTaken({ holder });
            }

            const elsewhere = yield* tx
              .select({ id: assetOrders.id })
              .from(assetOrders)
              .where(
                and(
                  eq(assetOrders.network, network),
                  eq(assetOrders.testnetEpoch, epochAt(Date.now())),
                  eq(assetOrders.wallet, proposed.order.from),
                  eq(assetOrders.status, "authorized"),
                ),
              );

            if (elsewhere[0]) return new SlotOccupied();

            if (proposed.claimable) {
              const open = yield* tx
                .select({ total: count() })
                .from(transfers)
                .where(openFrom(proposed.order.from));

              if ((open[0]?.total ?? 0) >= maxOpenClaimables)
                return new ClaimablesFull();
            }

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
                    new Date(Date.now() + approvalMargin * 1000),
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
        const values = Match.valueTags(settlement, {
          Applied: (applied): ConclusionColumns => ({
            status: "settled",
            concludedAt: DateTime.toDateUtc(applied.at),
            failure: null,
          }),
          Rejected: (): ConclusionColumns => ({
            status: "failed",
            concludedAt: new Date(),
            failure: "rejected",
          }),
          Expired: (): ConclusionColumns => ({
            status: "failed",
            concludedAt: new Date(),
            failure: "expired",
          }),
        });

        const rows = yield* db
          .update(transfers)
          .set(values)
          .where(
            and(
              scope,
              eq(transfers.id, id),
              eq(transfers.status, "authorized"),
            ),
          )
          .returning();

        const current = rows[0]
          ? yield* decode(rows[0])
          : Option.getOrUndefined(yield* find(id));

        if (!(current instanceof Concluded))
          return yield* new StoreFailure({
            cause: new Error("Transfer is not concluded"),
          });

        return current;
      });

      const wrap = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(Effect.mapError((cause) => new StoreFailure({ cause })));

      const inFlight = db
        .update(transfers)
        .set({ sweepCheckedAt: new Date() })
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
        .returning()
        .pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decode(row).pipe(
                Effect.flatMap((transfer) =>
                  transfer instanceof Authorized
                    ? Effect.succeed(transfer)
                    : Effect.fail(
                        new StoreFailure({
                          cause: new Error("Invalid in-flight state"),
                        }),
                      ),
                ),
              ),
            ),
          ),
        );

      return Transfers.of({
        find: (id) => wrap(find(id)),
        latestFrom: (sender) => wrap(latest(sender)),
        propose: (order, recipient, request) =>
          wrap(propose(order, recipient, request)),
        redraft: (proposed, request) => wrap(redraft(proposed, request)),
        authorize: (proposed, sealed) => wrap(authorize(proposed, sealed)),
        conclude: (id, settlement) => wrap(conclude(id, settlement)),
        inFlight: wrap(inFlight),
        openClaimables: (sender) =>
          wrap(
            db
              .select({ total: count() })
              .from(transfers)
              .where(openFrom(sender))
              .pipe(Effect.map((rows) => rows[0]?.total ?? 0)),
          ),
        openBalances: (address) => wrap(openBalances(address)),
        closeBalance: (balance) =>
          wrap(
            db
              .update(transfers)
              .set({ balanceClosedAt: new Date() })
              .where(and(unclaimed, eq(transfers.balanceId, balance)))
              .pipe(Effect.asVoid),
          ),
      });
    }),
  );
}
