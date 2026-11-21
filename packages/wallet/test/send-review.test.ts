import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  AddressRecipient,
  type Approval,
  ExternalRecipient,
  Holding,
  Offline,
  PaymentMemo,
  Pending,
  PositiveAmount,
  Settled,
  TransferId,
  type TransferOrder,
  type TransferStep,
  UsernameRecipient,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { TransferIntent, makeWalletEffects } from "../src/device/client";
import { DeviceWallet } from "../src/device/key-store";
import {
  memoryKeyStore,
  nowSeconds,
  savedWallet,
  sendActors,
  transferDraftOf,
  unusedPort,
} from "./device-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";

const actors = sendActors();
const amount = Schema.decodeSync(PositiveAmount)("10000000");
const memo = Schema.decodeSync(PaymentMemo)({ type: "id", value: "4521" });
const passkeys = new SoftwareAuthenticator("http://localhost:3000").passkeys;

const toExchange = new TransferIntent({
  to: AddressRecipient.make({ value: actors.exchange }),
  asset: baseAsset,
  amount,
  memo,
});

const toPedro = new TransferIntent({
  to: UsernameRecipient.make({ value: actors.pedroProfile.username }),
  asset: baseAsset,
  amount,
});

const exchangeDraft = () =>
  transferDraftOf(
    actors.payment({ to: actors.exchange, amount, memo }),
    new ExternalRecipient({ address: actors.exchange }),
  );

const pedroDraft = () =>
  transferDraftOf(
    actors.payment({ to: actors.pedro, amount }),
    actors.pedroProfile,
  );

const pedroClaimable = () =>
  transferDraftOf(
    actors.claimable({ to: actors.pedro, amount }),
    actors.pedroProfile,
  );

const receiptFields = (order: TransferOrder) => ({
  id: order.id,
  to: order.to,
  recipient: actors.pedroProfile,
  asset: order.asset,
  amount: order.amount,
});

const settledFor = (order: TransferOrder) =>
  new Settled({
    ...receiptFields(order),
    settledAt: DateTime.makeUnsafe(Date.now()),
  });

const deviceAnswering = (
  answer: (
    order: TransferOrder,
    approval: Option.Option<Approval>,
    call: number,
  ) => Effect.Effect<TransferStep, Offline>,
  overview?: WalletPort["overview"],
) => {
  const approvals: Array<Option.Option<Approval>> = [];
  const orderIds: Array<string> = [];
  const store = memoryKeyStore(Option.some(actors.wallet));

  const transfer: WalletPort["transfer"] = (order, approval) =>
    Effect.suspend(() => {
      approvals.push(approval);
      orderIds.push(order.id);

      return answer(order, approval, approvals.length);
    });

  const port = overview
    ? unusedPort({ overview, transfer })
    : unusedPort({ transfer });

  return {
    approvals,
    orderIds,
    client: makeWalletEffects(port, store, passkeys),
    store,
  };
};

const reviewed = Effect.fn(function* (
  client: ReturnType<typeof makeWalletEffects>,
  intent: TransferIntent,
) {
  const outcome = yield* client.review(intent);

  assertTagged(outcome, "PaymentReview");

  return outcome;
});

const markApproved = Effect.fn(function* (
  store: ReturnType<typeof memoryKeyStore>,
) {
  const current = yield* savedWallet(store);

  yield* store
    .write(new DeviceWallet({ ...current, approvedUntil: nowSeconds() + 120 }))
    .pipe(Effect.orDie);
});

it.live("reviews the envelope's facts without approving the draft", () =>
  Effect.gen(function* () {
    const { approvals, client } = deviceAnswering(() =>
      Effect.succeed(exchangeDraft()),
    );

    const review = yield* reviewed(client, toExchange);

    expect(review).toMatchObject({
      to: actors.exchange,
      asset: baseAsset,
      amount,
      memo,
      claimable: false,
    });
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

it.live("approves the reviewed order once under the same id", () =>
  Effect.gen(function* () {
    const { approvals, orderIds, client } = deviceAnswering((order, approval) =>
      Effect.succeed(
        Option.isSome(approval) ? settledFor(order) : pedroDraft(),
      ),
    );

    const review = yield* reviewed(client, toPedro);

    expect(review).toMatchObject({ to: actors.pedro, username: "pedro" });
    expect(yield* client.confirm(review)).toBeInstanceOf(Settled);
    expect(approvals.filter(Option.isSome)).toHaveLength(1);
    expect(new Set(orderIds)).toEqual(new Set([review.order.id]));
  }),
);

it.live("refuses a payment reviewed that turns into a claimable", () =>
  Effect.gen(function* () {
    const { approvals, client } = deviceAnswering((_o, _a, call) =>
      Effect.succeed(call === 1 ? pedroDraft() : pedroClaimable()),
    );

    const review = yield* reviewed(client, toPedro);

    expect((yield* client.confirm(review))._tag).toBe("DraftRejected");
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

it.live(
  "resume ignores an unapproved draft and reports an unsubmitted approval as outstanding",
  () =>
    Effect.gen(function* () {
      const { approvals, client, store } = deviceAnswering(
        () => Effect.succeed(pedroDraft()),
        () =>
          Effect.succeed(
            new Holding({
              profile: actors.pedroProfile,
              reserveSponsor: Option.some(actors.sponsor),
              balances: [],
              claimable: [],
              latest: Option.none(),
            }),
          ),
      );

      const review = yield* reviewed(client, toPedro);

      expect((yield* client.resume(review.order.id))._tag).toBe("NoTransfer");
      yield* markApproved(store);
      expect((yield* client.resume(review.order.id))._tag).toBe(
        "ApprovalOutstanding",
      );
      expect(approvals.filter(Option.isSome)).toHaveLength(0);
    }),
);

it.live("keeps the signed order when confirming fails offline", () =>
  Effect.gen(function* () {
    const { client, store } = deviceAnswering((_o, approval) =>
      Option.isSome(approval)
        ? Effect.fail(new Offline())
        : Effect.succeed(pedroDraft()),
    );

    const review = yield* reviewed(client, toPedro);

    expect(yield* client.confirm(review)).toEqual(new Offline());
    const kept = yield* savedWallet(store);

    expect(kept.transfer?.id).toBe(review.order.id);
    expect(kept.approvedUntil).toBeDefined();
  }),
);

it.effect(
  "follows an approved order past many Pending answers until settled",
  () =>
    Effect.gen(function* () {
      const device = deviceAnswering((order, _a, call) =>
        Effect.succeed(
          call === 1
            ? pedroDraft()
            : call < 16
              ? new Pending({
                  ...receiptFields(order),
                  expiresAt: DateTime.makeUnsafe((nowSeconds() + 120) * 1000),
                })
              : settledFor(order),
        ),
      );

      const review = yield* reviewed(device.client, toPedro);

      yield* markApproved(device.store);

      const following = yield* Effect.forkChild(
        device.client.resume(review.order.id),
      );

      yield* TestClock.adjust("2 minutes");
      const done = yield* Fiber.join(following);

      assertTagged(done, "Settled");
      expect(done.id).toBe(review.order.id);
      expect(device.approvals.filter(Option.isSome)).toHaveLength(0);
    }),
);

it.live(
  "recovers a forgotten receipt by id, misses on another id and surfaces overview failure",
  () =>
    Effect.gen(function* () {
      let settled: Option.Option<Settled> = Option.none();
      let offline = false;

      const device = deviceAnswering(
        () => Effect.succeed(pedroDraft()),
        () =>
          offline
            ? Effect.fail(new Offline())
            : Effect.succeed(
                new Holding({
                  profile: actors.pedroProfile,
                  reserveSponsor: Option.some(actors.sponsor),
                  balances: [],
                  claimable: [],
                  latest: settled,
                }),
              ),
      );

      const review = yield* reviewed(device.client, toPedro);
      const receipt = settledFor(review.order);

      settled = Option.some(receipt);
      expect(yield* device.client.resume(review.order.id)).toEqual(receipt);
      expect(
        (yield* device.client.resume(
          Schema.decodeSync(TransferId)(crypto.randomUUID()),
        ))._tag,
      ).toBe("NoTransfer");

      offline = true;
      expect(yield* device.client.resume(review.order.id)).toEqual(
        new Offline(),
      );
    }),
);

it.effect("stops following a payment still Pending after it expired", () =>
  Effect.gen(function* () {
    const device = deviceAnswering((order, _a, call) =>
      Effect.succeed(
        call === 1
          ? pedroDraft()
          : new Pending({
              ...receiptFields(order),
              expiresAt: DateTime.makeUnsafe(120_000),
            }),
      ),
    );

    const review = yield* reviewed(device.client, toPedro);

    yield* markApproved(device.store);

    const following = yield* Effect.forkChild(
      device.client.resume(review.order.id),
    );

    yield* TestClock.adjust("13 minutes");
    expect((yield* Fiber.join(following))._tag).toBe("Pending");
    expect(device.approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);
