import { beforeAll, beforeEach, expect, it, layer } from "@effect/vitest";
import { Database } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Amount,
  AssetCode,
  AssetId,
  NewPaymentRequest,
  PaymentRequestId,
  PaymentRequestNote,
  PaymentRequestStep,
  PositiveAmount,
  baseAsset,
  nativeAsset,
  precisionOf,
} from "../src/contract";
import { Directory } from "../src/server/Directory.server";
import { PaymentRequests } from "../src/server/PaymentRequests.server";
import {
  paymentRequests,
  usernames,
  wallets,
} from "../src/server/tables.server";
import { epochAt, network } from "../src/record-network";
import { assertTagged } from "./tagged";
import { dbLayer } from "./test-database";

const address = Schema.decodeSync(AccountAddress);

const maria = address(
  "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
);

const jorge = address(
  "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U",
);

const stranger = address(
  "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG",
);

const newRequest = (
  overrides: Partial<ConstructorParameters<typeof NewPaymentRequest>[0]> = {},
) =>
  new NewPaymentRequest({
    id: Schema.decodeSync(PaymentRequestId)("3yQ8fKm2Zd"),
    asset: baseAsset,
    amount: Schema.decodeSync(PositiveAmount)("200000000"),
    note: Schema.decodeSync(PaymentRequestNote)("Cena del viernes"),
    ...overrides,
  });

const missingId = Schema.decodeSync(PaymentRequestId)("zzzzzzzzzz");

type Standing = "active" | "opening" | "recovered";

const seedWallet = Effect.fn("seedWallet")(function* (
  owner: AccountAddress,
  status: Standing,
  username?: string,
) {
  const db = yield* Database;

  yield* db.insert(wallets).values({
    address: owner,
    status,
    network,
    testnetEpoch: epochAt(Date.now()),
  });

  if (username !== undefined)
    yield* db.insert(usernames).values({ address: owner, username });
});

const markPaid = (id: PaymentRequestId) =>
  Database.use((db) =>
    db
      .update(paymentRequests)
      .set({ status: "paid" })
      .where(eq(paymentRequests.id, id)),
  );

const testLayer = PaymentRequests.serviceLayer.pipe(
  Layer.provide(Directory.layer),
  Layer.provideMerge(dbLayer),
);

beforeAll(async () => {
  await Effect.runPromise(
    Database.use((db) =>
      migrate(db, { migrationsFolder: `${import.meta.dirname}/../drizzle` }),
    ).pipe(Effect.provide(dbLayer)),
  );
});

beforeEach(async () => {
  await Effect.runPromise(
    Database.use((db) =>
      db.execute(
        sql`truncate asset_orders, trustlines, transfers, usernames, wallets, backups, passkey_challenges, deposits, deposit_cursors, channel_leases, payment_requests`,
      ),
    ).pipe(Effect.provide(dbLayer)),
  );
});

layer(testLayer, { excludeTestServices: true, concurrent: false })(
  "payment requests",
  (it) => {
    it.effect("answers a retried create with the request's current state", () =>
      Effect.gen(function* () {
        yield* seedWallet(maria, "active", "maria");

        const requests = yield* PaymentRequests;
        const created = yield* requests.create(maria, newRequest());

        assertTagged(created, "PaymentRequestOpen");
        expect(created).toMatchObject({
          ...newRequest(),
          requester: "maria",
        });
        expect(yield* requests.create(maria, newRequest())).toEqual(created);

        yield* requests.cancel(maria, created.id);

        const retried = yield* requests.create(maria, newRequest());

        assertTagged(retried, "PaymentRequestCancelled");
      }),
    );

    it.effect.each([
      [
        "another amount",
        maria,
        { amount: Schema.decodeSync(PositiveAmount)("1") },
      ],
      ["another note", maria, { note: undefined }],
      ["another requester", jorge, {}],
    ] as const)("refuses a reused id with %s", ([, requester, change]) =>
      Effect.gen(function* () {
        yield* seedWallet(maria, "active", "maria");
        yield* seedWallet(jorge, "active", "jorge");

        const requests = yield* PaymentRequests;
        const created = yield* requests.create(maria, newRequest());

        const refused = yield* requests
          .create(requester, newRequest(change))
          .pipe(Effect.flip);

        assertTagged(refused, "StoreFailure");

        assertTagged(created, "PaymentRequestOpen");
        expect(yield* requests.read(created.id)).toEqual(created);
      }),
    );

    it.effect("reads open, cancelled and missing requests", () =>
      Effect.gen(function* () {
        yield* seedWallet(maria, "active", "maria");

        const requests = yield* PaymentRequests;
        const { id } = newRequest();

        yield* requests.create(maria, newRequest());

        const open = yield* requests.read(id);

        assertTagged(open, "PaymentRequestOpen");
        expect(open.requester).toBe("maria");
        expect(
          Schema.encodeSync(Schema.fromJsonString(PaymentRequestStep))(open),
        ).not.toContain(maria);

        yield* requests.cancel(maria, id);

        assertTagged(yield* requests.read(id), "PaymentRequestCancelled");
        assertTagged(yield* requests.read(missingId), "PaymentRequestNotFound");
      }),
    );

    it.effect("does not find a request from another testnet epoch", () =>
      Effect.gen(function* () {
        yield* seedWallet(maria, "active", "maria");

        const requests = yield* PaymentRequests;
        const { id } = newRequest();

        yield* requests.create(maria, newRequest());
        yield* Database.use((db) =>
          db.update(paymentRequests).set({ testnetEpoch: "an-earlier-epoch" }),
        );

        assertTagged(yield* requests.read(id), "PaymentRequestNotFound");
        assertTagged(
          yield* requests.cancel(maria, id),
          "PaymentRequestNotFound",
        );

        const listed = yield* requests.open(maria);

        assertTagged(listed, "OpenPaymentRequests");
        expect(listed.requests).toEqual([]);
      }),
    );

    it.effect("lists only the requester's open requests", () =>
      Effect.gen(function* () {
        yield* seedWallet(maria, "active", "maria");
        yield* seedWallet(jorge, "active", "jorge");

        const requests = yield* PaymentRequests;

        const id = Schema.decodeSync(PaymentRequestId);
        const kept = id("aaaaaaaaaa");
        const cancelled = id("bbbbbbbbbb");
        const paid = id("cccccccccc");
        const someoneElses = id("dddddddddd");

        yield* requests.create(maria, newRequest({ id: kept }));
        yield* requests.create(maria, newRequest({ id: cancelled }));
        yield* requests.create(maria, newRequest({ id: paid }));
        yield* requests.create(jorge, newRequest({ id: someoneElses }));
        yield* requests.cancel(maria, cancelled);
        yield* markPaid(paid);

        const listed = yield* requests.open(maria);

        assertTagged(listed, "OpenPaymentRequests");
        expect(listed.requests.map((request) => request.id)).toEqual([kept]);
      }),
    );

    it.effect("keeps a cancelled request cancelled and a paid one paid", () =>
      Effect.gen(function* () {
        yield* seedWallet(maria, "active", "maria");

        const requests = yield* PaymentRequests;
        const { id } = newRequest();

        yield* requests.create(maria, newRequest());

        assertTagged(
          yield* requests.cancel(maria, id),
          "PaymentRequestCancelled",
        );
        assertTagged(
          yield* requests.cancel(maria, id),
          "PaymentRequestCancelled",
        );

        yield* markPaid(id);

        assertTagged(yield* requests.cancel(maria, id), "PaymentRequestPaid");
        assertTagged(yield* requests.read(id), "PaymentRequestPaid");
        assertTagged(
          yield* requests.cancel(maria, missingId),
          "PaymentRequestNotFound",
        );
      }),
    );

    it.effect("never cancels or reveals another user's request", () =>
      Effect.gen(function* () {
        yield* seedWallet(maria, "active", "maria");
        yield* seedWallet(jorge, "active", "jorge");

        const requests = yield* PaymentRequests;
        const { id } = newRequest();

        yield* requests.create(maria, newRequest());

        assertTagged(
          yield* requests.cancel(jorge, id),
          "PaymentRequestNotFound",
        );
        assertTagged(yield* requests.read(id), "PaymentRequestOpen");
      }),
    );

    it.effect.each([
      ["an active wallet", "active", "maria", "PaymentRequestOpen"],
      [
        "an unopened wallet with a username",
        "opening",
        "maria",
        "PaymentRequestOpen",
      ],
      ["an unbound opening", "opening", undefined, "NotOpened"],
      ["a recovered wallet", "recovered", "maria", "NeedsReopening"],
    ] as const)("answers a create from %s", ([, status, username, expected]) =>
      Effect.gen(function* () {
        yield* seedWallet(maria, status, username);

        const requests = yield* PaymentRequests;
        const created = yield* requests.create(maria, newRequest());

        assertTagged(created, expected);
      }),
    );

    it.effect("refuses an address without a wallet", () =>
      Effect.gen(function* () {
        const requests = yield* PaymentRequests;

        assertTagged(
          yield* requests.create(stranger, newRequest()),
          "NotOpened",
        );
        assertTagged(yield* requests.open(stranger), "NotOpened");
        assertTagged(yield* requests.cancel(stranger, missingId), "NotOpened");
      }),
    );

    it.effect.each([
      ["the native asset", nativeAsset],
      [
        "another issuer's USDC",
        {
          id: Schema.decodeSync(AssetId)("USDC:another-issuer"),
          code: Schema.decodeSync(AssetCode)("USDC"),
        },
      ],
    ] as const)("does not accept %s", ([, asset]) =>
      Effect.gen(function* () {
        yield* seedWallet(maria, "active", "maria");

        const requests = yield* PaymentRequests;

        assertTagged(
          yield* requests.create(maria, newRequest({ asset })),
          "PaymentRequestAssetUnsupported",
        );
        assertTagged(
          yield* requests.read(newRequest().id),
          "PaymentRequestNotFound",
        );
      }),
    );
  },
);

it("rejects an amount above the asset's maximum", () => {
  const amount = Schema.decodeSync(Amount)(
    (precisionOf(baseAsset).maximum + 1n).toString(),
  );

  expect(Schema.is(NewPaymentRequest)({ ...newRequest(), amount })).toBe(false);
});

it.each([
  ["3yQ8fKm2Zd", true],
  ["3yQ8fKm2Z", false],
  ["3yQ8fKm2Zdd", false],
  ["3yQ8fKm2Z0", false],
  ["3yQ8fKm2ZO", false],
  ["3yQ8fKm2ZI", false],
  ["3yQ8fKm2Zl", false],
])("parses %j as a payment request id: %s", (text, accepted) => {
  expect(Schema.is(PaymentRequestId)(text)).toBe(accepted);
});

it.each([
  ["Cena del viernes", true],
  ["a".repeat(100), true],
  ["a".repeat(101), false],
  ["", false],
  [" Cena", false],
  ["Cena ", false],
  ["Cena\ndel viernes", false],
  ["Cena del viernes", false],
  ["Cena\u0000", false],
])("parses %j as a payment request note: %s", (text, accepted) => {
  expect(Schema.is(PaymentRequestNote)(text)).toBe(accepted);
});
