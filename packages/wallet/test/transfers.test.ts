import { expect, layer } from "@effect/vitest";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Profile, ServiceFailed } from "../src/contract";
import { Directory } from "../src/server/Directory.server";
import { Transfers } from "../src/server/Transfers.server";
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
          expect(world.submitted).toHaveLength(1);
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

          expect(results.map((r) => r._tag)).toEqual(["Pending", "Pending"]);
          const inFlight = yield* Transfers.use((t) => t.inFlight);

          expect(inFlight).toHaveLength(1);
          const storedEnvelope = inFlight[0]?.sealed.envelope;
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
