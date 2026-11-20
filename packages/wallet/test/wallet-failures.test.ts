import { createServer } from "node:http";
import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  AddressRecipient,
  Amount,
  LedgerUnreachable,
  PositiveAmount,
  ServerFailure,
  ServiceFailed,
  TransferOrder,
  Username,
  UsernameRecipient,
} from "../src/contract";
import { Applied, Chain } from "../src/server/Chain.server";
import { WalletSettings } from "../src/server/settings.server";
import { Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { assertTagged } from "./tagged";
import {
  addressOf,
  approve,
  create,
  feePayer,
  passkeyOrigin,
  sponsor,
  stores,
  orderFor,
  send,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const fundedSender = Effect.fn(function* (username = "maria") {
  const key = Keypair.random();

  yield* create(key, username);
  world.accounts.set(addressOf(key), {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("50000000")),
  });

  return key;
});

const signedTransfer = Effect.fn(function* (username: string) {
  const key = yield* fundedSender(username);

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));

  const draft = yield* send(order);

  assertTagged(draft, "TransferDraft");
  world.failSubmit = true;
  yield* send(order, approve(draft.request, key));
  world.failSubmit = false;

  const stored = Option.getOrThrow(
    yield* Transfers.use((transfers) => transfers.find(order.id)),
  );

  assertTagged(stored, "Authorized");

  return { order, hash: stored.sealed.hash };
});

const RpcMethod = Schema.fromJsonString(
  Schema.Struct({ method: Schema.String }),
);

const stellarAnswering = (reply: (method: string) => string) =>
  Effect.acquireRelease(
    Effect.promise(() => {
      const server = createServer((request, response) => {
        let body = "";

        request.on("data", (chunk) => {
          body += String(chunk);
        });

        request.on("end", () => {
          response.setHeader("Content-Type", "application/json");
          response.end(reply(Schema.decodeSync(RpcMethod)(body).method));
        });
      });

      return new Promise<typeof server>((resolve) =>
        server.listen(0, () => resolve(server)),
      );
    }),
    (server) =>
      Effect.promise(
        () => new Promise((resolve) => server.close(() => resolve(true))),
      ),
  ).pipe(
    Effect.map((server) =>
      Layer.fresh(Wallet.serviceLayer).pipe(
        Layer.provide(stores),
        Layer.provide(Layer.fresh(Chain.layer)),
        Layer.provide(
          Layer.succeed(WalletSettings, {
            rpcUrl: `http://127.0.0.1:${
              Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
                server.address(),
              ).port
            }`,
            reserveSponsorSecret: Redacted.make(sponsor.secret()),
            feePayerSecret: Redacted.make(feePayer.secret()),
            passkeyOrigins: [passkeyOrigin],
          }),
        ),
      ),
    ),
  );

const rpcError = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  error: { code: -32603, message: "could not query captive core" },
});

const undecodable = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { entries: "none", status: "LOST" },
});

const testnetReply = (method: string) =>
  Match.value(method).pipe(
    Match.when("getTransaction", () =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          latestLedger: 5825076,
          latestLedgerCloseTime: "1795149020",
          oldestLedger: 5704117,
          oldestLedgerCloseTime: "1794544229",
          status: "NOT_FOUND",
          applicationOrder: 0,
          feeBump: false,
          events: {},
          ledger: 0,
          createdAt: "0",
        },
      }),
    ),
    Match.when("getLedgerEntries", () =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { entries: [], latestLedger: 5825076 },
      }),
    ),
    Match.orElse(() => rpcError),
  );

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "answers an internal failure without telling the device why",
      () =>
        Effect.gen(function* () {
          yield* create(Keypair.random(), "pedro");

          const key = yield* fundedSender();

          const order = orderFor(
            key,
            UsernameRecipient.make({
              value: Schema.decodeSync(Username)("pedro"),
            }),
          );

          yield* send(order);

          const failure = yield* send(
            new TransferOrder({
              ...order,
              amount: Schema.decodeSync(PositiveAmount)("20000000"),
            }),
          ).pipe(Effect.flip);

          expect(failure).toEqual(new ServiceFailed());
          expect(
            JSON.stringify(Schema.encodeSync(ServerFailure)(failure)),
          ).not.toMatch(/order|cause|Error/);
        }),
    );

    it.effect("keeps sweeping other records after one record's read dies", () =>
      Effect.gen(function* () {
        const unreadable = yield* signedTransfer("maria");
        const readable = yield* signedTransfer("lucia");

        world.unreadable.add(unreadable.hash);
        world.evidence.set(
          readable.hash,
          new Applied({ at: DateTime.nowUnsafe() }),
        );

        expect(
          yield* Wallet.use((wallet) => wallet.sweep).pipe(Effect.flip),
        ).toEqual(new ServiceFailed());
        expect(
          Option.getOrThrow(
            yield* Transfers.use((transfers) =>
              transfers.find(readable.order.id),
            ),
          )._tag,
        ).toBe("Concluded");
      }),
    );

    it.effect(
      "keeps reconciling transfers when the claimable-balance read fails",
      () =>
        Effect.gen(function* () {
          const signed = yield* signedTransfer("maria");

          world.claimablesDown = true;
          world.evidence.set(
            signed.hash,
            new Applied({ at: DateTime.nowUnsafe() }),
          );

          expect(
            yield* Wallet.use((wallet) => wallet.sweep).pipe(Effect.flip),
          ).toEqual(new ServiceFailed());
          expect(
            Option.getOrThrow(
              yield* Transfers.use((transfers) =>
                transfers.find(signed.order.id),
              ),
            )._tag,
          ).toBe("Concluded");
        }),
    );

    it.effect(
      "answers LedgerUnreachable when Stellar replies with an error",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedSender();
          const stellar = yield* stellarAnswering(() => rpcError);

          expect(
            yield* Wallet.use((wallet) => wallet.overview(addressOf(key))).pipe(
              Effect.provide(stellar),
              Effect.flip,
            ),
          ).toEqual(new LedgerUnreachable());
        }).pipe(Effect.scoped),
    );

    it.effect("answers ServiceFailed when a ledger reply does not decode", () =>
      Effect.gen(function* () {
        const key = yield* fundedSender();
        const stellar = yield* stellarAnswering(() => undecodable);

        expect(
          yield* Wallet.use((wallet) => wallet.overview(addressOf(key))).pipe(
            Effect.provide(stellar),
            Effect.flip,
          ),
        ).toEqual(new ServiceFailed());
      }).pipe(Effect.scoped),
    );

    it.effect("keeps a transfer Pending on Stellar's real lookup replies", () =>
      Effect.gen(function* () {
        const signed = yield* signedTransfer("maria");
        const stellar = yield* stellarAnswering(testnetReply);

        expect(
          (yield* send(signed.order).pipe(Effect.provide(stellar)))._tag,
        ).toBe("Pending");
      }).pipe(Effect.scoped),
    );

    it.effect(
      "answers ServiceFailed when a transaction lookup reply does not decode",
      () =>
        Effect.gen(function* () {
          const signed = yield* signedTransfer("maria");
          const stellar = yield* stellarAnswering(() => undecodable);

          expect(
            yield* send(signed.order).pipe(
              Effect.provide(stellar),
              Effect.flip,
            ),
          ).toEqual(new ServiceFailed());
        }).pipe(Effect.scoped),
    );

    it.effect("answers LedgerUnreachable when Stellar does not answer", () =>
      Effect.gen(function* () {
        const key = yield* fundedSender();

        world.ledgerDown = true;

        expect(
          yield* Wallet.use((wallet) => wallet.overview(addressOf(key))).pipe(
            Effect.flip,
          ),
        ).toEqual(new LedgerUnreachable());
      }),
    );
  },
);
