import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  ExternalMemoRequired,
  ExternalRecipient,
  Pending,
  TransferId,
  TransferOrder,
} from "../src/contract";
import { TransferIntent, makeWalletEffects } from "../src/device/client";
import { DeviceWallet, PublicDeviceWallet } from "../src/device/key-store";
import {
  memoryKeyStore,
  nowSeconds,
  savedWallet,
  transferDraftOf,
  unusedPort,
} from "./device-fixtures";
import { sealedKeyStore } from "./sealed-wallet-fixtures";
import { assertTagged } from "./tagged";
import {
  actors,
  memoryDrafting,
  otherAmount,
  passkeys,
  payment,
  reviewed,
  sealedDrafting,
  toExchange,
} from "./send-fixtures";

const deviceWith = (...args: Parameters<typeof memoryDrafting>) => {
  const drafting = memoryDrafting(...args);

  return {
    ...drafting,
    client: makeWalletEffects(drafting.port, drafting.store, passkeys),
  };
};

const sealedWith = Effect.fn(function* (
  ...args: Parameters<typeof sealedDrafting>
) {
  const drafting = yield* sealedDrafting(...args);

  return {
    ...drafting,
    client: makeWalletEffects(
      drafting.port,
      sealedKeyStore,
      passkeys,
      drafting.device,
    ),
  };
});

it.live(
  "keeps a signed order whose signature expired while the server reports it pending",
  () =>
    Effect.gen(function* () {
      const signed = new TransferOrder({
        ...toExchange,
        id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
        from: actors.sender,
      });

      const inFlight = new Pending({
        ...signed,
        recipient: new ExternalRecipient({ address: actors.exchange }),
        expiresAt: DateTime.makeUnsafe(Date.now()),
      });

      const { approvals, client, store } = deviceWith(() => payment(), {
        answer: () => Option.some(inFlight),
        initial: new DeviceWallet({
          ...actors.wallet,
          transfer: signed,
          approvedUntil: nowSeconds() - 3600,
        }),
      });

      expect(
        (yield* client.review(
          new TransferIntent({ ...toExchange, amount: otherAmount }),
        ))._tag,
      ).toBe("ApprovalOutstanding");
      expect(approvals).toEqual([Option.none()]);
      expect((yield* savedWallet(store)).transfer?.id).toBe(signed.id);
    }),
);

it.live("releases an expired signed order the server never authorized", () =>
  Effect.gen(function* () {
    const oldOrder = new TransferOrder({
      ...toExchange,
      id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
      from: actors.sender,
    });

    const refusal = new ExternalMemoRequired({
      address: actors.exchange,
      exchange: "Synthetic exchange",
      source: "https://example.com",
    });

    const { client, orderIds, store } = deviceWith(() => payment(), {
      answer: () => Option.some(refusal),
      initial: new DeviceWallet({
        ...actors.wallet,
        transfer: oldOrder,
        approvedUntil: nowSeconds() - 3600,
      }),
    });

    expect(
      yield* client.review(
        new TransferIntent({ ...toExchange, amount: otherAmount }),
      ),
    ).toEqual(refusal);
    expect(orderIds).toHaveLength(2);
    expect(orderIds[0]).toBe(oldOrder.id);
    expect(orderIds[1]).not.toBe(oldOrder.id);
    expect((yield* savedWallet(store)).transfer?.id).toBe(orderIds[1]);
  }),
);

it.effect(
  "withdraws the reservation unsigned when the margin lapses during its commit and offers one fresh review",
  () =>
    Effect.gen(function* () {
      const writing = yield* Latch.make();

      const { approvals, client } = yield* sealedWith(
        (at) => payment(actors.sender, 21, at),
        {
          lifetime: 21,
          beforeFirstCommit: writing.open.pipe(
            Effect.andThen(Effect.sleep("1500 millis")),
          ),
        },
      );

      const review = yield* reviewed(client, toExchange);
      const confirming = yield* Effect.forkChild(client.confirm(review));

      yield* writing.await;
      yield* TestClock.adjust("3000 millis");

      const outcome = yield* Fiber.join(confirming);

      assertTagged(outcome, "PaymentReview");
      expect(outcome.redrafted).toBe(true);
      expect(approvals.filter(Option.isSome)).toHaveLength(0);
      expect(
        Option.getOrThrow(yield* sealedKeyStore.readPublic()).approvedUntil,
      ).toBeUndefined();
    }),
);

it.live(
  "an interrupt arriving while the reservation commits releases nothing and withdraws it",
  () =>
    Effect.gen(function* () {
      const committing = yield* Latch.make();
      const proceed = yield* Latch.make();

      const { approvals, client } = yield* sealedWith(() => payment(), {
        beforeFirstCommit: committing.open.pipe(Effect.andThen(proceed.await)),
      });

      const review = yield* reviewed(client, toExchange);
      const confirming = yield* Effect.forkChild(client.confirm(review));

      yield* committing.await;

      const interrupting = yield* Effect.forkChild(Fiber.interrupt(confirming));

      yield* proceed.open;
      yield* Fiber.join(interrupting);

      expect(approvals.filter(Option.isSome)).toHaveLength(0);
      expect(
        Option.getOrThrow(yield* sealedKeyStore.readPublic()).approvedUntil,
      ).toBeUndefined();
    }),
);

it.live(
  "replacing an expired order preserves a concurrent renewal of that order",
  () =>
    Effect.gen(function* () {
      const oldOrder = new TransferOrder({
        ...toExchange,
        id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
        from: actors.sender,
      });

      const store = memoryKeyStore(
        Option.some(
          new DeviceWallet({
            ...actors.wallet,
            transfer: oldOrder,
            approvedUntil: nowSeconds() - 3600,
          }),
        ),
      );

      const renewedUntil = nowSeconds() + 120;
      let renewed = false;

      const port = unusedPort({
        transfer: (_order, approval) =>
          Effect.gen(function* () {
            if (!renewed) {
              renewed = true;

              yield* store
                .updatePublic((current) =>
                  Option.some(
                    new PublicDeviceWallet({
                      ...current,
                      approvedUntil: renewedUntil,
                    }),
                  ),
                )
                .pipe(Effect.orDie);
            }

            if (Option.isSome(approval))
              return yield* Effect.die("Must not approve");

            return transferDraftOf(
              payment(),
              new ExternalRecipient({ address: actors.exchange }),
            );
          }),
      });

      const outcome = yield* makeWalletEffects(port, store, passkeys).review(
        new TransferIntent({ ...toExchange, amount: otherAmount }),
      );

      expect(outcome._tag).toBe("ApprovalOutstanding");

      const kept = Option.getOrThrow(yield* store.readPublic());

      expect(kept.transfer?.id).toBe(oldOrder.id);
      expect(kept.approvedUntil).toBe(renewedUntil);
    }),
);
