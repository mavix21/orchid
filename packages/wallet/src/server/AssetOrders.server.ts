import { makeDatabase } from "@workspace/db";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AssetCode,
  AssetFailed,
  AssetOrder,
  AssetOrderId,
  AssetPending,
  AssetSettled,
  IssuedAsset,
  SigningRequest,
} from "../contract";
import { readEnvelope } from "../stellar/envelopes";
import {
  approvalMargin,
  epochAt,
  maxSponsoredTrustlines,
  network,
  sweepBatchSize,
} from "../stellar/network";
import { Applied, Expired, Rejected, Sealed } from "./Chain.server";
import { StoreFailure } from "./Directory.server";
import { SlotOccupied, walletLock } from "./slot.server";
import { assetOrders, transfers, trustlines } from "./tables.server";

export class AssetProposed extends Schema.TaggedClass<AssetProposed>()(
  "AssetProposed",
  {
    order: AssetOrder,
    request: SigningRequest,
  },
) {}

export class AssetAuthorized extends Schema.TaggedClass<AssetAuthorized>()(
  "AssetAuthorized",
  {
    order: AssetOrder,
    sealed: Sealed,
  },
) {}

export class AssetConcluded extends Schema.TaggedClass<AssetConcluded>()(
  "AssetConcluded",
  {
    order: AssetOrder,
    receipt: Schema.Union([AssetSettled, AssetFailed]),
  },
) {}

export type StoredAssetOrder = AssetProposed | AssetAuthorized | AssetConcluded;

type AssetOrderRow = typeof assetOrders.$inferSelect;

interface ConclusionColumns {
  readonly status: "settled" | "failed";
  readonly concludedAt: Date;
  readonly failure: "expired" | "rejected" | null;
}

export const AssetOrderJson = Schema.fromJsonString(AssetOrder);
const OpensJson = Schema.fromJsonString(IssuedAsset);

export function assetPending(order: AssetAuthorized): AssetPending {
  return new AssetPending({
    id: order.order.id,
    action: order.order.action,
    expiresAt: order.sealed.expiresAt,
  });
}

function readRow(row: AssetOrderRow): StoredAssetOrder {
  const order = Schema.decodeSync(AssetOrderJson)(row.order);
  const expiresAt = DateTime.makeUnsafe(row.expiresAt);
  const fields = { id: order.id, action: order.action };

  return Match.value(row.status).pipe(
    Match.when(
      "proposed",
      () =>
        new AssetProposed({
          order,
          request: new SigningRequest({
            envelope: Schema.decodeSync(SigningRequest.fields.envelope)(
              row.envelope,
            ),
            expiresAt,
          }),
        }),
    ),
    Match.when("authorized", () => {
      if (!row.hash) throw new Error("Authorized asset order missing hash");

      return new AssetAuthorized({
        order,
        sealed: new Sealed({
          envelope: row.envelope,
          hash: row.hash,
          expiresAt,
        }),
      });
    }),
    Match.when("settled", () => {
      if (!row.concludedAt)
        throw new Error("Settled asset order missing ledger time");

      return new AssetConcluded({
        order,
        receipt: new AssetSettled({
          ...fields,
          settledAt: DateTime.makeUnsafe(row.concludedAt),
        }),
      });
    }),
    Match.when("failed", () => {
      if (!row.failure) throw new Error("Failed asset order missing reason");

      return new AssetConcluded({
        order,
        receipt: new AssetFailed({ ...fields, reason: row.failure }),
      });
    }),
    Match.exhaustive,
  );
}

function opensOf(request: SigningRequest): string | null {
  const facts = readEnvelope(request.envelope);

  return Option.isSome(facts) &&
    Predicate.isTagged(facts.value, "ClaimFacts") &&
    facts.value.opens
    ? Schema.encodeSync(OpensJson)(facts.value.opens)
    : null;
}

export class AssetOrders extends Context.Service<
  AssetOrders,
  {
    find(
      id: AssetOrderId,
    ): Effect.Effect<Option.Option<StoredAssetOrder>, StoreFailure>;

    inFlightFor(
      wallet: AccountAddress,
    ): Effect.Effect<Option.Option<AssetAuthorized>, StoreFailure>;
    propose(
      order: AssetOrder,
      request: SigningRequest,
    ): Effect.Effect<StoredAssetOrder, StoreFailure>;
    redraft(
      proposed: AssetProposed,
      request: SigningRequest,
    ): Effect.Effect<StoredAssetOrder, StoreFailure>;
    authorize(
      proposed: AssetProposed,
      sealed: Sealed,
    ): Effect.Effect<StoredAssetOrder | SlotOccupied, StoreFailure>;

    conclude(
      id: AssetOrderId,
      settlement: Applied | Rejected | Expired,
    ): Effect.Effect<AssetConcluded, StoreFailure>;
    readonly inFlight: Effect.Effect<
      ReadonlyArray<AssetAuthorized>,
      StoreFailure
    >;

    tracked(
      wallet: AccountAddress,
    ): Effect.Effect<ReadonlyArray<IssuedAsset>, StoreFailure>;

    forget(
      wallet: AccountAddress,
      asset: IssuedAsset,
    ): Effect.Effect<void, StoreFailure>;
  }
>()("@workspace/wallet/server/AssetOrders") {
  static readonly layer = Layer.effect(
    AssetOrders,
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

      const epoch = () => epochAt(Date.now());

      const scope = and(
        eq(assetOrders.network, network),
        eq(assetOrders.testnetEpoch, epoch()),
      );

      const decode = (row: AssetOrderRow) =>
        Effect.try({
          try: () => readRow(row),
          catch: (cause) => new StoreFailure({ cause }),
        });

      const signed = Effect.fn("AssetOrders.signed")(function* (
        row: AssetOrderRow,
      ) {
        const stored = yield* decode(row);

        if (!Predicate.isTagged(stored, "AssetAuthorized"))
          return yield* new StoreFailure({
            cause: new Error("Invalid in-flight state"),
          });

        return stored;
      });

      const find = Effect.fn("AssetOrders.find")(function* (id: AssetOrderId) {
        const rows = yield* db
          .select()
          .from(assetOrders)
          .where(and(scope, eq(assetOrders.id, id)));

        return rows[0] ? Option.some(yield* decode(rows[0])) : Option.none();
      });

      const found = Effect.fn("AssetOrders.found")(function* (
        id: AssetOrderId,
      ) {
        const existing = yield* find(id);

        if (Option.isNone(existing))
          return yield* new StoreFailure({
            cause: new Error("Asset order belongs to another network epoch"),
          });

        return existing.value;
      });

      const inFlightFor = Effect.fn("AssetOrders.inFlightFor")(function* (
        wallet: AccountAddress,
      ) {
        const rows = yield* db
          .select()
          .from(assetOrders)
          .where(
            and(
              scope,
              eq(assetOrders.wallet, wallet),
              eq(assetOrders.status, "authorized"),
            ),
          );

        return rows[0] ? Option.some(yield* signed(rows[0])) : Option.none();
      });

      const propose = Effect.fn("AssetOrders.propose")(function* (
        order: AssetOrder,
        request: SigningRequest,
      ) {
        const value = {
          id: order.id,
          wallet: order.wallet,
          order: Schema.encodeSync(AssetOrderJson)(order),
          opens: opensOf(request),
          network,
          testnetEpoch: epoch(),
          envelope: request.envelope,
          expiresAt: DateTime.toDateUtc(request.expiresAt),
        };

        const rows = yield* db
          .insert(assetOrders)
          .values({ ...value, status: "proposed" })
          .onConflictDoUpdate({
            target: assetOrders.id,
            set: {
              envelope: value.envelope,
              expiresAt: value.expiresAt,
              opens: value.opens,
            },
            setWhere: and(
              scope,
              eq(assetOrders.status, "proposed"),
              eq(assetOrders.order, value.order),
              lt(
                assetOrders.expiresAt,
                new Date(Date.now() + approvalMargin * 1000),
              ),
            ),
          })
          .returning();

        return rows[0] ? yield* decode(rows[0]) : yield* found(order.id);
      });

      const redraft = Effect.fn("AssetOrders.redraft")(function* (
        proposed: AssetProposed,
        request: SigningRequest,
      ) {
        const rows = yield* db
          .update(assetOrders)
          .set({
            envelope: request.envelope,
            expiresAt: DateTime.toDateUtc(request.expiresAt),
            opens: opensOf(request),
          })
          .where(
            and(
              scope,
              eq(assetOrders.id, proposed.order.id),
              eq(assetOrders.status, "proposed"),
              eq(assetOrders.envelope, proposed.request.envelope),
            ),
          )
          .returning();

        return rows[0]
          ? yield* decode(rows[0])
          : yield* found(proposed.order.id);
      });

      const authorize = (proposed: AssetProposed, sealed: Sealed) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            const { id, wallet } = proposed.order;

            yield* tx.execute(walletLock(wallet));

            const held = yield* tx
              .select({ id: assetOrders.id })
              .from(assetOrders)
              .where(
                and(
                  scope,
                  eq(assetOrders.wallet, wallet),
                  eq(assetOrders.status, "authorized"),
                ),
              );

            const paying = yield* tx
              .select({ id: transfers.id })
              .from(transfers)
              .where(
                and(
                  eq(transfers.network, network),
                  eq(transfers.testnetEpoch, epoch()),
                  eq(transfers.sender, wallet),
                  eq(transfers.status, "authorized"),
                ),
              );

            if (paying[0] || (held[0] && held[0].id !== id))
              return new SlotOccupied();

            const written = yield* tx
              .update(assetOrders)
              .set({
                status: "authorized",
                envelope: sealed.envelope,
                hash: sealed.hash,
              })
              .where(
                and(
                  scope,
                  eq(assetOrders.id, id),
                  eq(assetOrders.status, "proposed"),
                  eq(assetOrders.envelope, proposed.request.envelope),
                  gt(
                    assetOrders.expiresAt,
                    new Date(Date.now() + approvalMargin * 1000),
                  ),
                ),
              )
              .returning();

            if (written[0]) return yield* decode(written[0]);

            const fresh = yield* tx
              .select()
              .from(assetOrders)
              .where(and(scope, eq(assetOrders.id, id)));

            if (!fresh[0])
              return yield* new StoreFailure({
                cause: new Error("Asset order disappeared"),
              });

            return yield* decode(fresh[0]);
          }),
        );

      const line = (wallet: AccountAddress, asset: IssuedAsset) => ({
        address: wallet,
        network,
        testnetEpoch: epoch(),
        code: asset.code,
        issuer: asset.issuer,
      });

      const track = (
        tx: Transaction,
        wallet: AccountAddress,
        asset: IssuedAsset,
      ) =>
        tx.insert(trustlines).values(line(wallet, asset)).onConflictDoNothing();

      const untrack = (
        executor: typeof db | Transaction,
        wallet: AccountAddress,
        asset: IssuedAsset,
      ) =>
        executor
          .delete(trustlines)
          .where(
            and(
              eq(trustlines.address, wallet),
              eq(trustlines.network, network),
              eq(trustlines.testnetEpoch, epoch()),
              eq(trustlines.code, asset.code),
              eq(trustlines.issuer, asset.issuer),
            ),
          );

      const applied = Effect.fn("AssetOrders.applied")(function* (
        tx: Transaction,
        row: AssetOrderRow,
      ) {
        const { wallet, action } = Schema.decodeSync(AssetOrderJson)(row.order);

        yield* Match.valueTags(action, {
          OpenTrustline: ({ asset }) =>
            track(tx, wallet, asset).pipe(Effect.asVoid),
          CloseTrustline: ({ asset }) =>
            untrack(tx, wallet, asset).pipe(Effect.asVoid),
          ClaimBalance: ({ balance }) =>
            tx
              .update(transfers)
              .set({ balanceClosedAt: new Date() })
              .where(eq(transfers.balanceId, balance))
              .pipe(Effect.asVoid),
        });

        if (row.opens)
          yield* track(tx, wallet, Schema.decodeSync(OpensJson)(row.opens));
      });

      const conclude = Effect.fn("AssetOrders.conclude")(function* (
        id: AssetOrderId,
        settlement: Applied | Rejected | Expired,
      ) {
        const values = Match.valueTags(settlement, {
          Applied: (evidence): ConclusionColumns => ({
            status: "settled",
            concludedAt: DateTime.toDateUtc(evidence.at),
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

        const written = yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .update(assetOrders)
              .set(values)
              .where(
                and(
                  scope,
                  eq(assetOrders.id, id),
                  eq(assetOrders.status, "authorized"),
                ),
              )
              .returning();

            if (rows[0] && values.status === "settled")
              yield* applied(tx, rows[0]);

            return rows[0];
          }),
        );

        const current = written
          ? yield* decode(written)
          : Option.getOrUndefined(yield* find(id));

        if (!Predicate.isTagged(current, "AssetConcluded"))
          return yield* new StoreFailure({
            cause: new Error("Asset order is not concluded"),
          });

        return current;
      });

      const inFlight = db
        .update(assetOrders)
        .set({ sweepCheckedAt: new Date() })
        .where(
          and(
            scope,
            eq(assetOrders.status, "authorized"),
            inArray(
              assetOrders.id,
              db
                .select({ id: assetOrders.id })
                .from(assetOrders)
                .where(and(scope, eq(assetOrders.status, "authorized")))
                .orderBy(
                  sql`${assetOrders.sweepCheckedAt} asc nulls first`,
                  assetOrders.id,
                )
                .limit(sweepBatchSize),
            ),
          ),
        )
        .returning()
        .pipe(Effect.flatMap((rows) => Effect.forEach(rows, signed)));

      const tracked = (wallet: AccountAddress) =>
        db
          .select({ code: trustlines.code, issuer: trustlines.issuer })
          .from(trustlines)
          .where(
            and(
              eq(trustlines.address, wallet),
              eq(trustlines.network, network),
              eq(trustlines.testnetEpoch, epoch()),
            ),
          )
          .orderBy(trustlines.openedAt, trustlines.code, trustlines.issuer)

          .limit(maxSponsoredTrustlines * 4)
          .pipe(
            Effect.map((rows) =>
              rows.map((row) =>
                IssuedAsset.make({
                  code: Schema.decodeSync(AssetCode)(row.code),
                  issuer: Schema.decodeSync(AccountAddress)(row.issuer),
                }),
              ),
            ),
          );

      const wrap = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(Effect.mapError((cause) => new StoreFailure({ cause })));

      return AssetOrders.of({
        find: (id) => wrap(find(id)),
        inFlightFor: (wallet) => wrap(inFlightFor(wallet)),
        propose: (order, request) => wrap(propose(order, request)),
        redraft: (proposed, request) => wrap(redraft(proposed, request)),
        authorize: (proposed, sealed) => wrap(authorize(proposed, sealed)),
        conclude: (id, settlement) => wrap(conclude(id, settlement)),
        inFlight: wrap(inFlight),
        tracked: (wallet) => wrap(tracked(wallet)),
        forget: (wallet, asset) =>
          wrap(untrack(db, wallet, asset).pipe(Effect.asVoid)),
      });
    }),
  );
}
