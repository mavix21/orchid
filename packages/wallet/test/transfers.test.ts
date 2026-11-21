import { expect, layer } from "@effect/vitest";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Profile, ServiceFailed } from "../src/contract";
import { Chain } from "../src/server/Chain.server";
import { StoreFailure } from "../src/server/Directory.server";
import { Transfers } from "../src/server/Transfers.server";
import { assertTagged } from "./tagged";
import {
  addressOf,
  approve,
  draftTransfer,
  fakeChain,
  findTransfer,
  fundedWallet,
  runAcrossLockWait,
  selfOrder,
  send,
  settleHash,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  walletWithTransfers,
  world,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "a signed transfer survives failed submit and sweep finishes without the device",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);
          const draft = yield* draftTransfer(order);

          expect(draft.recipient).toBeInstanceOf(Profile);
          expect(yield* send(order)).toEqual(draft);

          world.failSubmit = true;
          expect((yield* send(order, approve(draft.request, key)))._tag).toBe(
            "Pending",
          );

          const stored = Option.getOrThrow(yield* findTransfer(order.id));

          assertTagged(stored, "Authorized");
          world.failSubmit = false;
          yield* sweep;
          expect(world.submitted.at(-1)?.hash).toBe(stored.sealed.hash);

          settleHash(stored.sealed.hash);
          yield* sweep;
          expect((yield* send(order))._tag).toBe("Settled");
        }),
    );

    it.effect(
      "concurrent approvals allow only one signed transfer per sender",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const orders = [selfOrder(key), selfOrder(key)];

          const drafts = yield* Effect.all(
            orders.map((o) => draftTransfer(o)),
            { concurrency: "unbounded" },
          );

          const results = yield* Effect.all(
            orders.map((order, i) => {
              const draft = drafts[i];

              if (!draft) throw new Error("Expected draft");

              return send(order, approve(draft.request, key));
            }),
            { concurrency: "unbounded" },
          );

          expect(results.filter(Predicate.isTagged("Pending"))).toHaveLength(1);
          expect(results.filter(Predicate.isTagged("SenderBusy"))).toHaveLength(
            1,
          );
          expect(yield* Transfers.use((t) => t.inFlight)).toHaveLength(1);
        }),
    );

    it.effect(
      "same id concurrent approvals keep one immutable sealed envelope",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);
          const draft = yield* draftTransfer(order);
          const before = world.submitted.length;

          const results = yield* Effect.all(
            [
              send(order, approve(draft.request, key)),
              send(order, approve(draft.request, key)),
            ],
            { concurrency: "unbounded" },
          );

          expect(results.every(Predicate.isTagged("Pending"))).toBe(true);
          const inFlight = yield* Transfers.use((t) => t.inFlight);

          expect(inFlight).toHaveLength(1);
          const storedEnvelope = inFlight[0]?.sealed.envelope;
          const submitted = world.submitted.slice(before);

          expect(submitted.length).toBeGreaterThan(0);
          expect(submitted.every((s) => s.envelope === storedEnvelope)).toBe(
            true,
          );
        }),
    );

    it.effect("database failure during authorization submits nothing", () =>
      Effect.gen(function* () {
        const key = yield* fundedWallet();
        const order = selfOrder(key);
        const draft = yield* draftTransfer(order);
        const initial = world.submitted.length;

        const brokenWallet = walletWithTransfers(() => ({
          authorize: () =>
            Effect.fail(
              new StoreFailure({ cause: new Error("Database unavailable") }),
            ),
        }));

        expect(
          yield* send(order, approve(draft.request, key)).pipe(
            Effect.flip,
            Effect.provide(brokenWallet),
          ),
        ).toEqual(new ServiceFailed());
        expect(world.submitted).toHaveLength(initial);
        expect(Option.getOrThrow(yield* findTransfer(order.id))._tag).toBe(
          "Proposed",
        );
      }),
    );

    it.effect(
      "authorization keeps a transfer Proposed when waiting on the post-lock slot query crosses the approval margin",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);

          yield* draftTransfer(order);
          const stored = Option.getOrThrow(yield* findTransfer(order.id));

          assertTagged(stored, "Proposed");

          const sealed = yield* Chain.use((c) =>
            c.seal(
              stored.request,
              Option.getOrThrow(approve(stored.request, key)),
              addressOf(key),
            ),
          ).pipe(Effect.provide(fakeChain));

          const { result: outcome } = yield* runAcrossLockWait({
            locktype: "relation",
            advance: "101 seconds",
            acquire: (tx) =>
              tx.execute(sql`lock table asset_orders in access exclusive mode`),
            run: Transfers.use((s) => s.authorize(stored, sealed)),
          });

          expect(outcome._tag).toBe("Proposed");
          expect(Option.getOrThrow(yield* findTransfer(order.id))._tag).toBe(
            "Proposed",
          );
        }),
    );
  },
);
