import { makeDatabase } from "@workspace/db";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Failed,
  Pending,
  Profile,
  ResolvedRecipient,
  Settled,
  SigningRequest,
  TransferId,
  TransferOrder,
} from "../contract";
import { approvalMargin, epochAt, network, sweepBatchSize } from "../stellar/network";
import { Applied, Expired, Rejected, Sealed } from "./Chain.server";
import { StoreFailure } from "./Directory.server";
import { transfers } from "./tables.server";

export class Proposed extends Schema.TaggedClass<Proposed>()("Proposed", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  request: SigningRequest,
}) {}

export class Authorized extends Schema.TaggedClass<Authorized>()("Authorized", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  sealed: Sealed,
}) {}

export class Concluded extends Schema.TaggedClass<Concluded>()("Concluded", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  receipt: Schema.Union([Settled, Failed]),
}) {}

export class SlotTaken extends Schema.TaggedClass<SlotTaken>()("SlotTaken", {
  holder: Authorized,
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
    expiresAt: transfer.sealed.expiresAt,
  });
}

function readRow(row: TransferRow): Transfer {
  const order = Schema.decodeSync(OrderJson)(row.order);
  const recipient = Schema.decodeSync(RecipientJson)(row.resolvedRecipient);
  const expiresAt = DateTime.makeUnsafe(row.expiresAt);
  const fields = { order, recipient };

  return Match.value(row.status).pipe(
    Match.when(
      "proposed",
      () =>
        new Proposed({
          ...fields,
          request: new SigningRequest({
            envelope: Schema.decodeSync(SigningRequest.fields.envelope)(row.envelope),
            expiresAt,
          }),
        }),
    ),
    Match.when("authorized", () => {
      if (!row.hash) throw new Error("Authorized transfer missing hash");

      return new Authorized({
        ...fields,
        sealed: new Sealed({ envelope: row.envelope, hash: row.hash, expiresAt }),
      });
    }),
    Match.when("settled", () => {
      if (!row.concludedAt) throw new Error("Settled transfer missing ledger time");

      return new Concluded({
        ...fields,
        receipt: new Settled({
          ...order,
          recipient,
          settledAt: DateTime.makeUnsafe(row.concludedAt),
        }),
      });
    }),
    Match.when("failed", () => {
      if (!row.failure) throw new Error("Failed transfer missing reason");

      return new Concluded({
        ...fields,
        receipt: new Failed({ ...order, recipient, reason: row.failure }),
      });
    }),
    Match.exhaustive,
  );
}

export class Transfers extends Context.Service<
  Transfers,
  {
    find(id: TransferId): Effect.Effect<Option.Option<Transfer>, StoreFailure>;
    latestFrom(sender: AccountAddress): Effect.Effect<Option.Option<Transfer>, StoreFailure>;
    propose(
      order: TransferOrder,
      recipient: ResolvedRecipient,
      request: SigningRequest,
    ): Effect.Effect<Transfer, StoreFailure>;
    redraft(proposed: Proposed, request: SigningRequest): Effect.Effect<Transfer, StoreFailure>;
    authorize(
      proposed: Proposed,
      sealed: Sealed,
    ): Effect.Effect<Transfer | SlotTaken, StoreFailure>;
    conclude(
      id: TransferId,
      settlement: Applied | Rejected | Expired,
    ): Effect.Effect<Concluded, StoreFailure>;
    readonly inFlight: Effect.Effect<ReadonlyArray<Authorized>, StoreFailure>;
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
        Effect.try({ try: () => readRow(row), catch: (cause) => new StoreFailure({ cause }) });

      const find = Effect.fn("Transfers.find")(function* (id: TransferId) {
        const rows = yield* db
          .select()
          .from(transfers)
          .where(and(scope, eq(transfers.id, id)));

        return rows[0] ? Option.some(yield* decode(rows[0])) : Option.none();
      });

      const latest = Effect.fn("Transfers.latestFrom")(function* (sender: AccountAddress) {
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
          .orderBy(desc(sql`${transfers.status} = 'authorized'`), desc(transfers.createdAt))
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
        };

        const rows = yield* db
          .insert(transfers)
          .values({ ...value, status: "proposed" })
          .onConflictDoUpdate({
            target: transfers.id,
            set: { envelope: request.envelope, expiresAt: value.expiresAt },
            setWhere: and(
              scope,
              eq(transfers.status, "proposed"),
              eq(transfers.order, value.order),
              lt(transfers.expiresAt, new Date(Date.now() + approvalMargin * 1000)),
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
            yield* tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${proposed.order.from}, 0))`,
            );

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

              if (holder instanceof Authorized) return new SlotTaken({ holder });
            }

            const written = yield* tx
              .update(transfers)
              .set({ status: "authorized", envelope: sealed.envelope, hash: sealed.hash })
              .where(
                and(
                  scope,
                  eq(transfers.id, id),
                  eq(transfers.status, "proposed"),
                  eq(transfers.envelope, request.envelope),
                  gt(transfers.expiresAt, new Date(Date.now() + approvalMargin * 1000)),
                ),
              )
              .returning();

            if (written[0]) return yield* decode(written[0]);

            const fresh = yield* tx
              .select()
              .from(transfers)
              .where(and(scope, eq(transfers.id, id)));

            if (!fresh[0])
              return yield* new StoreFailure({ cause: new Error("Transfer disappeared") });

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
          .where(and(scope, eq(transfers.id, id), eq(transfers.status, "authorized")))
          .returning();

        const current = rows[0] ? yield* decode(rows[0]) : Option.getOrUndefined(yield* find(id));

        if (!(current instanceof Concluded))
          return yield* new StoreFailure({ cause: new Error("Transfer is not concluded") });

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
                .orderBy(sql`${transfers.sweepCheckedAt} asc nulls first`, transfers.id)
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
                        new StoreFailure({ cause: new Error("Invalid in-flight state") }),
                      ),
                ),
              ),
            ),
          ),
        );

      return Transfers.of({
        find: (id) => wrap(find(id)),
        latestFrom: (sender) => wrap(latest(sender)),
        propose: (order, recipient, request) => wrap(propose(order, recipient, request)),
        redraft: (proposed, request) => wrap(redraft(proposed, request)),
        authorize: (proposed, sealed) => wrap(authorize(proposed, sealed)),
        conclude: (id, settlement) => wrap(conclude(id, settlement)),
        inFlight: wrap(inFlight),
      });
    }),
  );
}
