import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ExternalRecipient,
  PositiveAmount,
  ServiceFailed,
  type TransferDraft,
  TransferOrder,
} from "../src/contract";
import { Applied, Chain, Rejected } from "../src/server/Chain.server";
import { Transfers } from "../src/server/Transfers.server";
import { readEnvelope } from "../src/stellar/envelopes";
import { assertTagged } from "./tagged";
import {
  addressOf,
  approve,
  authorizeTransfer,
  draftTransfer,
  fakeChain,
  findTransfer,
  fundHolder,
  fundedWallet,
  overviewOf,
  selfOrder,
  send,
  settleHash,
  authorizedTransfers,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  walletWithChain,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const paymentSequence = (draft: TransferDraft) => {
  const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

  assertTagged(facts, "PaymentFacts");

  return facts.sequence;
};

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "near-expiry unsigned drafts refresh, while authorized bytes never change",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);

          yield* send(order);
          yield* Database.use((db) =>
            db.execute(
              sql`update transfers set "expiresAt" = now() + interval '10 seconds' where id = ${order.id}`,
            ),
          );

          const refreshed = yield* draftTransfer(order);

          expect(
            DateTime.toEpochMillis(refreshed.request.expiresAt),
          ).toBeGreaterThan(Date.now() + 20_000);
          yield* send(order, approve(refreshed.request, key));

          const authorized = Option.getOrThrow(yield* findTransfer(order.id));

          assertTagged(authorized, "Authorized");
          expect(
            yield* Transfers.use((s) =>
              s.propose(
                order,
                new ExternalRecipient({ address: addressOf(Keypair.random()) }),
                refreshed.request,
              ),
            ),
          ).toEqual(authorized);

          const changed = new TransferOrder({
            ...order,
            amount: Schema.decodeSync(PositiveAmount)("20000000"),
          });

          expect(yield* send(changed).pipe(Effect.flip)).toEqual(
            new ServiceFailed(),
          );
          expect(Option.getOrThrow(yield* findTransfer(order.id))).toEqual(
            authorized,
          );
        }),
    );

    it.effect(
      "double tap redrafts a still-live stale sequence before accepting its approval",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const first = selfOrder(key);
          const second = selfOrder(key);
          const firstDraft = yield* draftTransfer(first);
          const secondDraft = yield* draftTransfer(second);

          expect(paymentSequence(firstDraft)).toBe("1001");
          expect(paymentSequence(secondDraft)).toBe("1001");
          yield* send(first, approve(firstDraft.request, key));

          const signed = Option.getOrThrow(yield* findTransfer(first.id));

          assertTagged(signed, "Authorized");
          fundHolder(key, { sequence: "1001" });
          settleHash(signed.sealed.hash);
          expect((yield* send(first))._tag).toBe("Settled");

          const redrafted = yield* send(
            second,
            approve(secondDraft.request, key),
          );

          assertTagged(redrafted, "TransferDraft");
          expect(paymentSequence(redrafted)).toBe("1002");
          expect(Option.getOrThrow(yield* findTransfer(second.id))._tag).toBe(
            "Proposed",
          );
          expect(
            (yield* send(second, approve(redrafted.request, key)))._tag,
          ).toBe("Pending");
        }),
    );

    it.effect(
      "SlotTaken reconciliation refreshes the waiting draft after the holder consumes its sequence",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const first = selfOrder(key);
          const second = selfOrder(key);
          const firstDraft = yield* draftTransfer(first);
          const secondDraft = yield* draftTransfer(second);

          yield* send(first, approve(firstDraft.request, key));
          const signed = Option.getOrThrow(yield* findTransfer(first.id));

          assertTagged(signed, "Authorized");

          const settlingWallet = walletWithChain((actual) => ({
            settlement: (sealed) =>
              sealed.hash === signed.sealed.hash
                ? Effect.sync(() => {
                    fundHolder(key, { sequence: "1001" });

                    return new Applied({ at: DateTime.nowUnsafe() });
                  })
                : actual.settlement(sealed),
          }));

          const result = yield* send(
            second,
            approve(secondDraft.request, key),
          ).pipe(Effect.provide(settlingWallet));

          assertTagged(result, "TransferDraft");
          expect(paymentSequence(result)).toBe("1002");
          expect((yield* send(second, approve(result.request, key)))._tag).toBe(
            "Pending",
          );
        }),
    );

    it.effect(
      "a proven consumed authorization concludes and releases the sender slot",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);
          const { authorized } = yield* authorizeTransfer(key, order);

          fundHolder(key, { sequence: "1001" });
          world.evidence.set(
            authorized.sealed.hash,
            new Rejected({ code: "sequence_consumed" }),
          );
          yield* sweep;
          expect((yield* send(order))._tag).toBe("Failed");
          expect(yield* authorizedTransfers).toHaveLength(0);

          const nextOrder = selfOrder(key);
          const next = yield* draftTransfer(nextOrder);

          expect(paymentSequence(next)).toBe("1002");
          expect(
            (yield* send(nextOrder, approve(next.request, key)))._tag,
          ).toBe("Pending");
        }),
    );

    it.effect(
      "an unsigned newer draft cannot hide the latest authorized or settled receipt",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const first = selfOrder(key);
          const draft = yield* draftTransfer(first);

          yield* send(selfOrder(key));
          yield* send(first, approve(draft.request, key));

          const pendingView = yield* overviewOf(addressOf(key));

          assertTagged(pendingView, "Holding");
          expect(Option.getOrThrow(pendingView.latest)._tag).toBe("Pending");
          expect(Option.getOrThrow(pendingView.latest).id).toBe(first.id);

          const signed = Option.getOrThrow(yield* findTransfer(first.id));

          assertTagged(signed, "Authorized");
          settleHash(signed.sealed.hash);
          expect((yield* send(first))._tag).toBe("Settled");

          const settledView = yield* overviewOf(addressOf(key));

          assertTagged(settledView, "Holding");
          expect(Option.getOrThrow(settledView.latest)._tag).toBe("Settled");
          expect(Option.getOrThrow(settledView.latest).id).toBe(first.id);
        }),
    );

    it.effect(
      "a sequence change during signing redrafts before durable authorization",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);
          const draft = yield* draftTransfer(order);

          const advancingWallet = walletWithChain((actual) => ({
            seal: (request, approval, holder) =>
              actual
                .seal(request, approval, holder)
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => fundHolder(key, { sequence: "1001" })),
                  ),
                ),
          }));

          const result = yield* send(order, approve(draft.request, key)).pipe(
            Effect.provide(advancingWallet),
          );

          assertTagged(result, "TransferDraft");
          expect(paymentSequence(result)).toBe("1002");
          expect(Option.getOrThrow(yield* findTransfer(order.id))._tag).toBe(
            "Proposed",
          );
          expect(yield* authorizedTransfers).toHaveLength(0);
        }),
    );

    it.effect(
      "a stale redraft cannot replace a concurrent durable authorization",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);
          const draft = yield* draftTransfer(order);
          const proposed = Option.getOrThrow(yield* findTransfer(order.id));

          assertTagged(proposed, "Proposed");
          yield* send(order, approve(draft.request, key));

          const authorized = Option.getOrThrow(yield* findTransfer(order.id));

          assertTagged(authorized, "Authorized");
          fundHolder(key, { sequence: "1001" });

          const replacement = yield* Chain.use((c) =>
            c.draftPayment(
              order.from,
              addressOf(key),
              order.asset,
              order.amount,
            ),
          ).pipe(Effect.provide(fakeChain));

          const saved = yield* Transfers.use((s) =>
            s.redraft(proposed, replacement),
          );

          assertTagged(saved, "Authorized");
          expect(saved.sealed.envelope).toBe(authorized.sealed.envelope);
        }),
    );
  },
);
