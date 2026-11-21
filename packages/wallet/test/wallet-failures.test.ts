import { expect, layer } from "@effect/vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { LedgerUnreachable, ServiceFailed } from "../src/contract";
import {
  jsonResponse,
  ledgerKeys,
  queriedHash,
  rpcError,
  rpcOk,
  submittedTransaction,
  testnetReply,
} from "./rpc-answering";
import { assertTagged } from "./tagged";
import {
  addressOf,
  authorizeTransfer,
  claimFor,
  findTransfer,
  findWallet,
  fundedWallet,
  opening,
  overviewOf,
  selfOrder,
  send,
  settleHash,
  sponsor,
  stellarAnswering,
  stellarWallet,
  sweep,
  timeOutRpc,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const signedTransfer = Effect.fn(function* (username: string) {
  const key = yield* fundedWallet(username);
  const order = selfOrder(key);

  const { authorized } = yield* authorizeTransfer(key, order, {
    failSubmit: true,
  });

  return {
    order,
    hash: authorized.sealed.hash,
    envelope: authorized.sealed.envelope,
  };
});

const undecodable = rpcOk({ entries: "none", status: "LOST" });

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect("keeps sweeping other records after one record's read dies", () =>
      Effect.gen(function* () {
        const unreadable = yield* signedTransfer("maria");
        const readable = yield* signedTransfer("lucia");

        world.unreadable.add(unreadable.hash);
        settleHash(readable.hash);

        expect(yield* sweep.pipe(Effect.flip)).toEqual(new ServiceFailed());
        expect(
          Option.getOrThrow(yield* findTransfer(readable.order.id))._tag,
        ).toBe("Concluded");
      }),
    );

    it.effect(
      "keeps reconciling transfers when the claimable-balance read fails",
      () =>
        Effect.gen(function* () {
          const signed = yield* signedTransfer("maria");

          world.claimablesDown = true;
          settleHash(signed.hash);

          expect(yield* sweep.pipe(Effect.flip)).toEqual(new ServiceFailed());
          expect(
            Option.getOrThrow(yield* findTransfer(signed.order.id))._tag,
          ).toBe("Concluded");
        }),
    );

    it.effect.each([
      {
        name: "a JSON-RPC error",
        reply: rpcError,
        expected: new LedgerUnreachable(),
      },
      {
        name: "invalid JSON",
        reply: "not json",
        expected: new ServiceFailed(),
      },
      {
        name: "a schema mismatch",
        reply: undecodable,
        expected: new ServiceFailed(),
      },
    ])(
      "answers $expected._tag when overview gets $name",
      ({ reply, expected }) =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();

          expect(
            yield* overviewOf(addressOf(key)).pipe(
              Effect.provide(stellarAnswering(() => reply)),
              Effect.flip,
            ),
          ).toEqual(expected);
        }),
    );

    it.effect.each([
      { name: "malformed transaction lookup reply", reply: () => undecodable },
      {
        name: "unrecognized sendTransaction status",
        reply: (method: string) =>
          method === "sendTransaction"
            ? rpcOk({ status: "UNKNOWN" })
            : testnetReply(method),
      },
    ])(
      "answers ServiceFailed and keeps an authorized order on $name",
      ({ reply }) =>
        Effect.gen(function* () {
          const signed = yield* signedTransfer("maria");

          expect(
            yield* send(signed.order).pipe(
              Effect.provide(stellarAnswering(reply)),
              Effect.flip,
            ),
          ).toEqual(new ServiceFailed());
          expect(
            Option.getOrThrow(yield* findTransfer(signed.order.id))._tag,
          ).toBe("Authorized");
        }),
    );

    it.effect(
      "answers LedgerUnreachable and leaves no opening row when draftOpening sponsor read times out",
      () =>
        Effect.gen(function* () {
          const claim = claimFor(Keypair.random(), "maria");

          const sponsorKey = xdr.LedgerKey.account(
            new xdr.LedgerKeyAccount({ accountId: sponsor.xdrPublicKey() }),
          ).toXdr("base64");

          const started = yield* Latch.make();

          const stellar = stellarWallet((method, req) =>
            method === "getLedgerEntries" &&
            ledgerKeys(req).includes(sponsorKey)
              ? started.open.pipe(Effect.andThen(Effect.never))
              : Effect.succeed(jsonResponse(testnetReply(method))),
          );

          expect(
            yield* timeOutRpc(
              started,
              opening(claim).pipe(Effect.provide(stellar), Effect.flip),
            ),
          ).toEqual(new LedgerUnreachable());
          expect(yield* findWallet(claim.address)).toEqual(Option.none());
        }),
    );

    it.effect(
      "keeps an authorized transfer Pending on NOT_FOUND and submit timeout, then settles on replay without resubmitting",
      () =>
        Effect.gen(function* () {
          const signed = yield* signedTransfer("maria");
          const started = yield* Latch.make();
          const submitted: Array<string> = [];
          let settled = false;

          const stellar = stellarWallet((method, req) =>
            Match.value(method).pipe(
              Match.when("sendTransaction", () => {
                submitted.push(submittedTransaction(req));

                return started.open.pipe(Effect.andThen(Effect.never));
              }),
              Match.when("getTransaction", () =>
                Effect.succeed(
                  jsonResponse(
                    settled && queriedHash(req) === signed.hash
                      ? rpcOk({
                          status: "SUCCESS",
                          createdAt: "1795149020",
                          latestLedger: 5825076,
                          latestLedgerCloseTime: "1795149020",
                          oldestLedgerCloseTime: "1794544229",
                        })
                      : testnetReply(method),
                  ),
                ),
              ),
              Match.orElse(() =>
                Effect.succeed(jsonResponse(testnetReply(method))),
              ),
            ),
          );

          expect(
            (yield* timeOutRpc(
              started,
              send(signed.order).pipe(Effect.provide(stellar)),
            ))._tag,
          ).toBe("Pending");
          expect(submitted).toEqual([signed.envelope]);
          expect(
            Option.getOrThrow(yield* findTransfer(signed.order.id))._tag,
          ).toBe("Authorized");

          settled = true;

          const replayed = yield* send(signed.order).pipe(
            Effect.provide(stellar),
          );

          assertTagged(replayed, "Settled");
          expect(replayed.id).toBe(signed.order.id);
          expect(submitted).toEqual([signed.envelope]);
        }),
    );
  },
);
