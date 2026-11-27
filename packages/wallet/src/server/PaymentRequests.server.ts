import { Database } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  AssetCode,
  AssetId,
  type CancelPaymentRequestStep,
  type CreatePaymentRequestStep,
  NeedsReopening,
  type NewPaymentRequest,
  NotOpened,
  OpenPaymentRequests,
  type OpenPaymentRequestsStep,
  PaymentRequestAssetUnsupported,
  PaymentRequestCancelled,
  PaymentRequestId,
  PaymentRequestNote,
  PaymentRequestNotFound,
  PaymentRequestOpen,
  PaymentRequestPaid,
  type PaymentRequestPort,
  type PaymentRequestStep,
  PositiveAmount,
  type Profile,
  Username,
  baseAsset,
  sameAsset,
} from "../contract";
import { epochAt, network } from "../record-network";
import { Directory } from "./Directory.server";
import { Principal } from "./Principal.server";
import { StoreFailure } from "./store-failure.server";
import { paymentRequests } from "./tables.server";

type PaymentRequestRow = typeof paymentRequests.$inferSelect;

const requestOf = (row: PaymentRequestRow) => ({
  id: Schema.decodeSync(PaymentRequestId)(row.id),
  requester: Schema.decodeSync(Username)(row.requester),
  asset: {
    id: Schema.decodeSync(AssetId)(row.assetId),
    code: Schema.decodeSync(AssetCode)(row.assetCode),
  },
  amount: Schema.decodeSync(PositiveAmount)(row.amount.toString()),
  note:
    row.note === null
      ? undefined
      : Schema.decodeSync(PaymentRequestNote)(row.note),
  createdAt: DateTime.fromDateUnsafe(row.createdAt),
});

const stepOf = (row: PaymentRequestRow) => {
  const request = requestOf(row);

  switch (row.status) {
    case "open":
      return new PaymentRequestOpen(request);
    case "paid":
      return new PaymentRequestPaid(request);
    case "cancelled":
      return new PaymentRequestCancelled(request);
  }
};

const stored = <A, E>(query: Effect.Effect<A, E>) =>
  query.pipe(Effect.mapError((cause) => new StoreFailure({ cause })));

const sameRequest = (
  row: PaymentRequestRow,
  requester: Username,
  request: NewPaymentRequest,
) =>
  row.requester === requester &&
  row.assetId === request.asset.id &&
  row.assetCode === request.asset.code &&
  row.amount === request.amount &&
  row.note === (request.note ?? null);

export class PaymentRequests extends Context.Service<
  PaymentRequests,
  PaymentRequestPort<StoreFailure>
>()("@workspace/wallet/server/PaymentRequests") {
  static readonly serviceLayer = Layer.effect(
    PaymentRequests,
    Effect.gen(function* () {
      const db = yield* Database;
      const directory = yield* Directory;

      const current = Effect.map(Clock.currentTimeMillis, (now) =>
        and(
          eq(paymentRequests.network, network),
          eq(paymentRequests.testnetEpoch, epochAt(now)),
        ),
      );

      const find = Effect.fn("PaymentRequests.find")(function* (
        id: PaymentRequestId,
        requester?: Username,
      ) {
        const scope = yield* current;

        const rows = yield* stored(
          db
            .select()
            .from(paymentRequests)
            .where(
              and(
                scope,
                eq(paymentRequests.id, id),
                requester === undefined
                  ? undefined
                  : eq(paymentRequests.requester, requester),
              ),
            ),
        );

        return Option.fromNullishOr(rows[0]);
      });

      const requesterAt = Effect.fn("PaymentRequests.requesterAt")(function* (
        address: AccountAddress,
      ): Effect.fn.Return<
        { readonly profile: Profile; readonly recovered: boolean } | NotOpened,
        StoreFailure
      > {
        const wallet = yield* directory.byAddress(address);

        if (Option.isNone(wallet)) return new NotOpened();

        if (wallet.value.status === "opening") {
          const bound = yield* directory.unopened(wallet.value);

          return Option.match(bound, {
            onNone: () => new NotOpened(),
            onSome: (profile) => ({ profile, recovered: false }),
          });
        }

        return {
          profile: yield* directory.profile(wallet.value),
          recovered: wallet.value.status === "recovered",
        };
      });

      const create = Effect.fn("PaymentRequests.create")(function* (
        address: AccountAddress,
        request: NewPaymentRequest,
      ): Effect.fn.Return<CreatePaymentRequestStep, StoreFailure> {
        const requester = yield* requesterAt(address);

        if (requester instanceof NotOpened) return requester;

        const { profile, recovered } = requester;

        if (recovered) return new NeedsReopening({ profile });

        if (!sameAsset(request.asset, baseAsset))
          return new PaymentRequestAssetUnsupported();

        const now = yield* Clock.currentTimeMillis;

        yield* stored(
          db
            .insert(paymentRequests)
            .values({
              id: request.id,
              requester: profile.username,
              network,
              testnetEpoch: epochAt(now),
              assetId: request.asset.id,
              assetCode: request.asset.code,
              amount: request.amount,
              note: request.note ?? null,
              status: "open",
            })
            .onConflictDoNothing(),
        );

        const found = yield* find(request.id, profile.username);

        if (
          Option.isNone(found) ||
          !sameRequest(found.value, profile.username, request)
        )
          return yield* new StoreFailure({
            cause: new Error(
              "Payment request id cannot identify a different request",
            ),
          });

        return stepOf(found.value);
      });

      const read = Effect.fn("PaymentRequests.read")(function* (
        id: PaymentRequestId,
      ): Effect.fn.Return<PaymentRequestStep, StoreFailure> {
        const found = yield* find(id);

        return Option.match(found, {
          onNone: () => new PaymentRequestNotFound(),
          onSome: stepOf,
        });
      });

      const open = Effect.fn("PaymentRequests.open")(function* (
        address: AccountAddress,
      ): Effect.fn.Return<OpenPaymentRequestsStep, StoreFailure> {
        const requester = yield* requesterAt(address);

        if (requester instanceof NotOpened) return requester;

        const scope = yield* current;

        const rows = yield* stored(
          db
            .select()
            .from(paymentRequests)
            .where(
              and(
                scope,
                eq(paymentRequests.requester, requester.profile.username),
                eq(paymentRequests.status, "open"),
              ),
            )
            .orderBy(desc(paymentRequests.createdAt), paymentRequests.id),
        );

        return new OpenPaymentRequests({
          requests: rows.map((row) => new PaymentRequestOpen(requestOf(row))),
        });
      });

      const cancel = Effect.fn("PaymentRequests.cancel")(function* (
        address: AccountAddress,
        id: PaymentRequestId,
      ): Effect.fn.Return<CancelPaymentRequestStep, StoreFailure> {
        const requester = yield* requesterAt(address);

        if (requester instanceof NotOpened) return requester;

        const { username } = requester.profile;
        const scope = yield* current;
        const now = yield* Clock.currentTimeMillis;

        const [cancelled] = yield* stored(
          db
            .update(paymentRequests)
            .set({ status: "cancelled", cancelledAt: new Date(now) })
            .where(
              and(
                scope,
                eq(paymentRequests.id, id),
                eq(paymentRequests.requester, username),
                eq(paymentRequests.status, "open"),
              ),
            )
            .returning(),
        );

        if (cancelled) return new PaymentRequestCancelled(requestOf(cancelled));

        const found = yield* find(id, username);

        if (Option.isNone(found)) return new PaymentRequestNotFound();

        const settled = stepOf(found.value);

        if (settled instanceof PaymentRequestOpen)
          return yield* new StoreFailure({
            cause: new Error("Open payment request was not cancelled"),
          });

        return settled;
      });

      return PaymentRequests.of({ create, read, open, cancel });
    }),
  );
  static readonly layer = PaymentRequests.serviceLayer.pipe(
    Layer.provideMerge(Principal.layer),
    Layer.provide(Directory.layer),
  );
}
