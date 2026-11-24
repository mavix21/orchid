import { expect, layer } from "@effect/vitest";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Profile, ServiceFailed } from "../src/contract";
import { Directory } from "../src/server/Directory.server";
import { ReconcileTransfer } from "../src/server/work-queue.server";
import { assertTagged } from "./tagged";
import {
  addressOf,
  approve,
  draftTransfer,
  findTransfer,
  fundedWallet,
  selfOrder,
  send,
  settleHash,
  ageSignedWork,
  attend,
  authorizeTransfer,
  authorizedTransfers,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "a proposed transfer is not authorized once its wallet stopped being active",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);
          const draft = yield* draftTransfer(order);

          yield* Directory.use((directory) =>
            Effect.flatMap(directory.byAddress(addressOf(key)), (row) =>
              directory.recover(Option.getOrThrow(row)),
            ),
          );
          expect((yield* send(order, approve(draft.request, key)))._tag).toBe(
            "NotOpened",
          );
          assertTagged(
            Option.getOrThrow(yield* findTransfer(order.id)),
            "Proposed",
          );
        }),
    );

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
          world.queueDown = true;
          expect((yield* send(order, approve(draft.request, key)))._tag).toBe(
            "Pending",
          );

          const stored = Option.getOrThrow(yield* findTransfer(order.id));

          assertTagged(stored, "Authorized");
          expect(world.queued).toEqual([]);
          world.failSubmit = false;
          yield* sweep;
          expect(world.submitted.at(-1)?.hash).toBe(stored.sealed.hash);

          settleHash(stored.sealed.hash);
          yield* sweep;
          expect((yield* send(order))._tag).toBe("Settled");
        }),
    );

    it.effect(
      "a queue message resubmits a lost transfer submission and concludes it before the transaction expires",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);

          const { authorized } = yield* authorizeTransfer(key, order, {
            failSubmit: true,
          });

          const message = new ReconcileTransfer({ id: order.id });
          const submissions = world.submitted.length;

          expect(world.queued).toEqual([message]);
          assertTagged(yield* attend(message), "WorkRetry");
          expect(world.submitted).toHaveLength(submissions + 1);
          expect(world.submitted.at(-1)?.hash).toBe(authorized.sealed.hash);

          settleHash(authorized.sealed.hash);
          assertTagged(yield* attend(message, 2), "WorkFinished");
          assertTagged(
            Option.getOrThrow(yield* findTransfer(order.id)),
            "Concluded",
          );
        }),
    );

    it.effect(
      "a queue message stops retrying an undecided transfer once the transaction is long expired",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const order = selfOrder(key);

          yield* authorizeTransfer(key, order);
          assertTagged(
            yield* attend(new ReconcileTransfer({ id: order.id })),
            "WorkRetry",
          );

          yield* ageSignedWork;
          assertTagged(
            yield* attend(new ReconcileTransfer({ id: order.id })),
            "WorkFinished",
          );
          assertTagged(
            Option.getOrThrow(yield* findTransfer(order.id)),
            "Authorized",
          );
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
          expect(yield* authorizedTransfers).toHaveLength(1);
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

          expect(results.map((r) => r._tag)).toEqual(["Pending", "Pending"]);
          const inFlight = yield* authorizedTransfers;

          expect(inFlight).toHaveLength(1);
          const storedEnvelope = inFlight[0]?.envelope;
          const submitted = world.submitted.slice(before);

          expect(new Set(submitted.map((s) => s.envelope))).toEqual(
            new Set([storedEnvelope]),
          );
        }),
    );

    it.effect("database failure during authorization submits nothing", () =>
      Effect.gen(function* () {
        const key = yield* fundedWallet();
        const order = selfOrder(key);
        const draft = yield* draftTransfer(order);
        const initial = world.submitted.length;

        const db = yield* Database;

        yield* db.execute(sql`
          create or replace function fail_transfer_update() returns trigger as $$
          begin
            raise exception 'Database unavailable';
          end;
          $$ language plpgsql
        `);

        yield* db.execute(sql`
          create trigger fail_transfer_update
          before update on transfers
          for each row execute function fail_transfer_update()
        `);

        const failure = yield* send(order, approve(draft.request, key)).pipe(
          Effect.flip,
          Effect.ensuring(
            db
              .execute(
                sql`drop trigger if exists fail_transfer_update on transfers`,
              )
              .pipe(
                Effect.andThen(
                  db.execute(
                    sql`drop function if exists fail_transfer_update()`,
                  ),
                ),
                Effect.orDie,
              ),
          ),
        );

        expect(failure).toEqual(new ServiceFailed());
        expect(world.submitted).toHaveLength(initial);
        expect(Option.getOrThrow(yield* findTransfer(order.id))._tag).toBe(
          "Proposed",
        );
      }),
    );
  },
);
