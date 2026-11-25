import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Transfers } from "../src/server/Transfers.server";
import { assertTagged } from "./tagged";
import {
  addressOf,
  assess,
  authorizeTransfer,
  draftTransfer,
  findWallet,
  fundedWallet,
  selfOrder,
  settleHash,
  storedTransfers,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect("an assessed intent predicts the draft and stores nothing", () =>
      Effect.gen(function* () {
        const key = yield* fundedWallet();
        const order = selfOrder(key);
        const assessment = yield* assess(key, order);

        assertTagged(assessment, "TransferAssessment");
        expect(yield* storedTransfers(addressOf(key))).toEqual([]);

        const draft = yield* draftTransfer(order);

        expect(draft.recipient).toEqual(assessment.recipient);
        expect(draft.memoRequired).toBe(assessment.memoRequired);
      }),
    );

    it.effect(
      "an assessment reports a signed transfer still in flight without reconciling it",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();

          const { authorized } = yield* authorizeTransfer(key, selfOrder(key), {
            failSubmit: true,
          });

          settleHash(authorized.sealed.hash);

          const submissions = world.submitted.length;

          assertTagged(yield* assess(key, selfOrder(key)), "SenderBusy");
          expect(world.submitted).toHaveLength(submissions);
          assertTagged(
            Option.getOrThrow(
              yield* Transfers.use((transfers) =>
                transfers.latestFrom(addressOf(key)),
              ),
            ),
            "Authorized",
          );
        }),
    );

    it.effect("an assessment leaves a vanished account's wallet active", () =>
      Effect.gen(function* () {
        const key = yield* fundedWallet();

        world.accounts.delete(addressOf(key));
        assertTagged(yield* assess(key, selfOrder(key)), "NotOpened");
        expect(
          Option.getOrThrow(yield* findWallet(addressOf(key))).status,
        ).toBe("active");
      }),
    );
  },
);
