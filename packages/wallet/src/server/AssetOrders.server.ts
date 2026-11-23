import { Database } from "@workspace/db";
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
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
  AccountAddress,
  AssetCode,
  AssetOrder,
  AssetOrderId,
  type BalanceId,
  IssuedAsset,
  SigningRequest,
} from "../contract";
import {
  approvalMargin,
  epochAt,
  maxSponsoredTrustlines,
  network,
  sweepBatchSize,
} from "../stellar/network";
import { Applied, Expired, Rejected, Sealed } from "./Chain.server";
import { StoreFailure } from "./Directory.server";
import {
  linkCleaned,
  ordersOnBalance,
  receivedLinksToClean,
} from "./asset-order-links.server";
import {
  type AssetAuthorized,
  AssetConcluded,
  AssetOrderJson,
  type AssetOrderRow,
  type AssetProposed,
  type ConclusionColumns,
  OpensJson,
  type StoredAssetOrder,
  opensOf,
  readRow,
} from "./asset-order-records.server";
import { SlotOccupied, WalletInactive, walletLock } from "./slot.server";
import { assetOrders, transfers, trustlines, wallets } from "./tables.server";

export {
  AssetAuthorized,
  AssetConcluded,
  AssetOrderJson,
  AssetProposed,
  type StoredAssetOrder,
  assetPending,
} from "./asset-order-records.server";

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
    ): Effect.Effect<
      StoredAssetOrder | SlotOccupied | WalletInactive,
      StoreFailure
    >;

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

    settledClaim(
      wallet: AccountAddress,
      balance: BalanceId,
    ): Effect.Effect<boolean, StoreFailure>;

    onBalance(
      balance: BalanceId,
    ): Effect.Effect<ReadonlyArray<StoredAssetOrder>, StoreFailure>;

    readonly receivedLinksToClean: Effect.Effect<
      ReadonlyArray<AssetConcluded>,
      StoreFailure
    >;

    linkCleaned(id: AssetOrderId): Effect.Effect<void, StoreFailure>;
  }
>()("@workspace/wallet/server/AssetOrders") {
  static readonly layer = Layer.effect(
    AssetOrders,
    Effect.gen(function* () {
      const db = yield* Database;

      type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

      const scopeAt = (now: number) =>
        and(
          eq(assetOrders.network, network),
          eq(assetOrders.testnetEpoch, epochAt(now)),
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
        const now = yield* Clock.currentTimeMillis;

        const rows = yield* db
          .select()
          .from(assetOrders)
          .where(and(scopeAt(now), eq(assetOrders.id, id)));

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
        const now = yield* Clock.currentTimeMillis;

        const rows = yield* db
          .select()
          .from(assetOrders)
          .where(
            and(
              scopeAt(now),
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
        const now = yield* Clock.currentTimeMillis;

        const value = {
          id: order.id,
          wallet: order.wallet,
          order: Schema.encodeSync(AssetOrderJson)(order),
          opens: opensOf(request),
          balanceId:
            Predicate.isTagged(order.action, "ClaimBalance") ||
            Predicate.isTagged(order.action, "ReceiveLink")
              ? order.action.balance
              : null,
          network,
          testnetEpoch: epochAt(now),
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
              scopeAt(now),
              eq(assetOrders.status, "proposed"),
              eq(assetOrders.order, value.order),
              lt(
                assetOrders.expiresAt,
                DateTime.toDateUtc(
                  DateTime.makeUnsafe(now + approvalMargin * 1000),
                ),
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
        const now = yield* Clock.currentTimeMillis;

        const rows = yield* db
          .update(assetOrders)
          .set({
            envelope: request.envelope,
            expiresAt: DateTime.toDateUtc(request.expiresAt),
            opens: opensOf(request),
          })
          .where(
            and(
              scopeAt(now),
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

            const owner = yield* tx
              .select({ status: wallets.status })
              .from(wallets)
              .where(
                and(eq(wallets.network, network), eq(wallets.address, wallet)),
              );

            if (owner[0]?.status !== "active") return new WalletInactive();

            const lockedAt = yield* Clock.currentTimeMillis;
            const scope = scopeAt(lockedAt);

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
                  eq(transfers.testnetEpoch, epochAt(lockedAt)),
                  eq(transfers.sender, wallet),
                  eq(transfers.status, "authorized"),
                ),
              );

            if (paying[0] || (held[0] && held[0].id !== id))
              return new SlotOccupied();

            const commitAt = yield* Clock.currentTimeMillis;

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
              .from(assetOrders)
              .where(and(scope, eq(assetOrders.id, id)));

            if (!fresh[0])
              return yield* new StoreFailure({
                cause: new Error("Asset order disappeared"),
              });

            return yield* decode(fresh[0]);
          }),
        );

      const line = (
        wallet: AccountAddress,
        asset: IssuedAsset,
        now: number,
      ) => ({
        address: wallet,
        network,
        testnetEpoch: epochAt(now),
        code: asset.code,
        issuer: asset.issuer,
      });

      const track = (
        tx: Transaction,
        wallet: AccountAddress,
        asset: IssuedAsset,
        now: number,
      ) =>
        tx
          .insert(trustlines)
          .values(line(wallet, asset, now))
          .onConflictDoNothing();

      const untrack = (
        executor: typeof db | Transaction,
        wallet: AccountAddress,
        asset: IssuedAsset,
        now: number,
      ) =>
        executor
          .delete(trustlines)
          .where(
            and(
              eq(trustlines.address, wallet),
              eq(trustlines.network, network),
              eq(trustlines.testnetEpoch, epochAt(now)),
              eq(trustlines.code, asset.code),
              eq(trustlines.issuer, asset.issuer),
            ),
          );

      const closeBalance = (
        tx: Transaction,
        balance: BalanceId,
        now: DateTime.Utc,
      ) =>
        tx
          .update(transfers)
          .set({ balanceClosedAt: DateTime.toDateUtc(now) })
          .where(
            and(
              eq(transfers.balanceId, balance),
              isNull(transfers.balanceClosedAt),
            ),
          )
          .pipe(Effect.asVoid);

      const applied = Effect.fn("AssetOrders.applied")(function* (
        tx: Transaction,
        row: AssetOrderRow,
        now: DateTime.Utc,
      ) {
        const { wallet, action } = Schema.decodeSync(AssetOrderJson)(row.order);
        const nowMillis = DateTime.toEpochMillis(now);

        yield* Match.valueTags(action, {
          OpenTrustline: ({ asset }) =>
            track(tx, wallet, asset, nowMillis).pipe(Effect.asVoid),
          CloseTrustline: ({ asset }) =>
            untrack(tx, wallet, asset, nowMillis).pipe(Effect.asVoid),
          ClaimBalance: ({ balance }) => closeBalance(tx, balance, now),
          ReceiveLink: ({ balance }) => closeBalance(tx, balance, now),
        });

        if (row.opens)
          yield* track(
            tx,
            wallet,
            Schema.decodeSync(OpensJson)(row.opens),
            nowMillis,
          );
      });

      const conclude = Effect.fn("AssetOrders.conclude")(function* (
        id: AssetOrderId,
        settlement: Applied | Rejected | Expired,
      ) {
        const now = yield* DateTime.now;
        const nowDate = DateTime.toDateUtc(now);
        const scope = scopeAt(DateTime.toEpochMillis(now));

        const values = Match.valueTags(settlement, {
          Applied: (evidence): ConclusionColumns => ({
            status: "settled",
            concludedAt: DateTime.toDateUtc(evidence.at),
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
              yield* applied(tx, rows[0], now);

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

      const inFlight = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const scope = scopeAt(DateTime.toEpochMillis(now));

        const rows = yield* db
          .update(assetOrders)
          .set({ sweepCheckedAt: DateTime.toDateUtc(now) })
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
          .returning();

        return yield* Effect.forEach(rows, signed);
      });

      const tracked = Effect.fn("AssetOrders.tracked")(function* (
        wallet: AccountAddress,
      ) {
        const now = yield* Clock.currentTimeMillis;

        const rows = yield* db
          .select({ code: trustlines.code, issuer: trustlines.issuer })
          .from(trustlines)
          .where(
            and(
              eq(trustlines.address, wallet),
              eq(trustlines.network, network),
              eq(trustlines.testnetEpoch, epochAt(now)),
            ),
          )
          .orderBy(trustlines.openedAt, trustlines.code, trustlines.issuer)
          .limit(maxSponsoredTrustlines * 4);

        return rows.map((row) =>
          IssuedAsset.make({
            code: Schema.decodeSync(AssetCode)(row.code),
            issuer: Schema.decodeSync(AccountAddress)(row.issuer),
          }),
        );
      });

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
        onBalance: (balance) =>
          wrap(
            ordersOnBalance(balance, decode).pipe(
              Effect.provideService(Database, db),
            ),
          ),
        receivedLinksToClean: wrap(
          receivedLinksToClean(decode).pipe(
            Effect.provideService(Database, db),
          ),
        ),
        linkCleaned: (id) =>
          wrap(linkCleaned(id).pipe(Effect.provideService(Database, db))),
        forget: (wallet, asset) =>
          wrap(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => untrack(db, wallet, asset, now)),
              Effect.asVoid,
            ),
          ),
        settledClaim: (wallet, balance) =>
          wrap(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                db
                  .select({ id: assetOrders.id })
                  .from(assetOrders)
                  .where(
                    and(
                      scopeAt(now),
                      eq(assetOrders.wallet, wallet),
                      eq(assetOrders.status, "settled"),
                      eq(assetOrders.balanceId, balance),
                    ),
                  )
                  .limit(1),
              ),
              Effect.map((rows) => rows.length > 0),
            ),
          ),
      });
    }),
  );
}
