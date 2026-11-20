import { expect, it } from "@effect/vitest";
import { Account, Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  AddressRecipient,
  type Approval,
  ExternalRecipient,
  NotOpened,
  PaymentMemo,
  PositiveAmount,
  Profile,
  SigningRequest,
  TransferDraft,
  type TransferStep,
  type UnsignedEnvelope,
  Username,
  UsernameRecipient,
  Holding,
  InvalidResponse,
  LedgerUnreachable,
  Offline,
  Pending,
  ServiceFailed,
  Settled,
  type WalletPort,
  type WalletUnavailable,
  baseAsset,
} from "../src/contract";
import {
  type PaymentReview,
  TransferIntent,
  makeWalletClient,
  makeWalletEffects,
} from "../src/device/client";
import { DeviceWallet, type KeyStore } from "../src/device/key-store";
import { generateSecretPhrase } from "../src/device/secret-phrase";
import { signingKey } from "../src/device/signing";
import { draftClaimable } from "../src/stellar/asset-envelopes";
import { draftPayment } from "../src/stellar/envelopes";
import { SoftwareAuthenticator } from "./software-authenticator";
import { addressOf } from "./wallet-harness";

const phrase = generateSecretPhrase();
const sender = addressOf(signingKey(phrase));
const sponsor = addressOf(Keypair.random());
const exchange = addressOf(Keypair.random());
const pedro = addressOf(Keypair.random());
const amount = Schema.decodeSync(PositiveAmount)("10000000");
const memo = Schema.decodeSync(PaymentMemo)({ type: "id", value: "4521" });

const pedroProfile = new Profile({
  username: Schema.decodeSync(Username)("pedro"),
  address: pedro,
});

const now = () => Math.floor(Date.now() / 1000);

const toExchange = new TransferIntent({
  to: AddressRecipient.make({ value: exchange }),
  asset: baseAsset,
  amount,
  memo,
});

const toPedro = new TransferIntent({
  to: UsernameRecipient.make({ value: pedroProfile.username }),
  asset: baseAsset,
  amount,
});

const exchangePayment = () =>
  draftPayment({
    source: new Account(sender, "100"),
    to: exchange,
    asset: baseAsset,
    amount,
    memo,
    minTime: now(),
    maxTime: now() + 120,
  });

const pedroPayment = () =>
  draftPayment({
    source: new Account(sender, "100"),
    to: pedro,
    asset: baseAsset,
    amount,
    minTime: now(),
    maxTime: now() + 120,
  });

const pedroClaimable = () =>
  draftClaimable({
    source: new Account(sender, "100"),
    reserveSponsor: sponsor,
    to: pedro,
    asset: baseAsset,
    amount,
    minTime: now(),
    maxTime: now() + 120,
  });

const draftOf = (
  envelope: UnsignedEnvelope,
  recipient: Profile | ExternalRecipient,
) =>
  new TransferDraft({
    request: new SigningRequest({
      envelope,
      expiresAt: DateTime.makeUnsafe((now() + 120) * 1000),
    }),
    recipient,
    memoRequired: false,
  });

const deviceAnswering = (
  answer: (approval: Option.Option<Approval>, call: number) => TransferStep,
  unavailable: (call: number) => Option.Option<WalletUnavailable> = () =>
    Option.none(),
  overview: WalletPort["overview"] = () => Effect.die("Not used by send"),
) => {
  const approvals: Array<Option.Option<Approval>> = [];
  const orderIds: Array<string> = [];

  let saved = Option.some(
    new DeviceWallet({
      phrase,
      address: sender,
      username: Schema.decodeSync(Username)("maria"),
      reserveSponsor: sponsor,
      backup: "stored",
    }),
  );

  const store: KeyStore = {
    read: () => Effect.sync(() => saved),
    write: (wallet) =>
      Effect.sync(() => {
        saved = Option.some(wallet);
      }),
  };

  const unused = () => Effect.die("Not used by send");

  const port: WalletPort = {
    overview,
    open: unused,
    manage: unused,
    passkeyChallenge: unused,
    enroll: unused,
    restore: unused,
    transfer: (order, approval) =>
      Effect.suspend(() => {
        approvals.push(approval);
        orderIds.push(order.id);

        return Option.match(unavailable(approvals.length), {
          onNone: () => Effect.succeed(answer(approval, approvals.length)),
          onSome: Effect.fail,
        });
      }),
  };

  const authenticator = new SoftwareAuthenticator("http://localhost:3000");
  const client = makeWalletClient(port, store, authenticator.passkeys);
  const effects = makeWalletEffects(port, store, authenticator.passkeys);

  return { approvals, orderIds, client, effects, store };
};

const reviewed = (
  client: ReturnType<typeof makeWalletClient>,
  intent: TransferIntent,
) =>
  Effect.promise(() => client.review(intent)).pipe(
    Effect.flatMap((outcome) =>
      Predicate.isTagged(outcome, "PaymentReview")
        ? Effect.succeed(outcome)
        : Effect.die(new Error(`Expected a review, got ${outcome._tag}`)),
    ),
  );

it.effect("reviews the envelope's facts without approving the draft", () =>
  Effect.gen(function* () {
    const { approvals, client } = deviceAnswering(() =>
      draftOf(exchangePayment(), new ExternalRecipient({ address: exchange })),
    );

    const review = yield* Effect.promise(() => client.review(toExchange));

    expect(review._tag).toBe("PaymentReview");
    expect(review).toMatchObject({
      to: exchange,
      asset: baseAsset,
      amount,
      memo,
      claimable: false,
    });
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

it.effect("approves the reviewed order once under the same id", () =>
  Effect.gen(function* () {
    const { approvals, orderIds, client } = deviceAnswering((approval) =>
      Option.isSome(approval)
        ? new NotOpened()
        : draftOf(pedroPayment(), pedroProfile),
    );

    const review = yield* reviewed(client, toPedro);

    expect(review).toMatchObject({ to: pedro, username: "pedro" });
    expect(yield* Effect.promise(() => client.confirm(review))).toEqual(
      new NotOpened(),
    );
    expect(approvals.filter(Option.isSome)).toHaveLength(1);
    expect(new Set(orderIds)).toEqual(new Set([review.order.id]));
  }),
);

it.effect("refuses a payment reviewed that turns into a claimable", () =>
  Effect.gen(function* () {
    const { approvals, client } = deviceAnswering((_, call) =>
      draftOf(call === 1 ? pedroPayment() : pedroClaimable(), pedroProfile),
    );

    const review = yield* reviewed(client, toPedro);

    expect((yield* Effect.promise(() => client.confirm(review)))._tag).toBe(
      "DraftRejected",
    );
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

it.effect("resumes an approved order without signing again", () =>
  Effect.gen(function* () {
    const { approvals, client, store } = deviceAnswering(
      (approval, call) =>
        Option.isSome(approval) || call > 1
          ? new NotOpened()
          : draftOf(pedroPayment(), pedroProfile),
      () => Option.none(),
      () => Effect.succeed(new NotOpened()),
    );

    const review = yield* reviewed(client, toPedro);

    expect(
      (yield* Effect.promise(() => client.resume(review.order.id)))._tag,
    ).toBe("NoTransfer");

    const wallet = Option.getOrThrow(yield* store.read().pipe(Effect.orDie));

    yield* store
      .write(new DeviceWallet({ ...wallet, approvedUntil: now() + 120 }))
      .pipe(Effect.orDie);

    expect(yield* Effect.promise(() => client.resume(review.order.id))).toEqual(
      new NotOpened(),
    );
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

it.effect(
  "reports an approved order the server never received as outstanding",
  () =>
    Effect.gen(function* () {
      const { approvals, client, store } = deviceAnswering(() =>
        draftOf(pedroPayment(), pedroProfile),
      );

      const review = yield* reviewed(client, toPedro);

      const wallet = Option.getOrThrow(yield* store.read().pipe(Effect.orDie));

      yield* store
        .write(new DeviceWallet({ ...wallet, approvedUntil: now() + 120 }))
        .pipe(Effect.orDie);

      expect(
        (yield* Effect.promise(() => client.resume(review.order.id)))._tag,
      ).toBe("ApprovalOutstanding");
      expect(approvals.filter(Option.isSome)).toHaveLength(0);
    }),
);

const unavailableAnswers: ReadonlyArray<WalletUnavailable> = [
  new Offline(),
  new LedgerUnreachable(),
  new ServiceFailed(),
  new InvalidResponse(),
];

it.effect.each(unavailableAnswers)(
  "keeps the signed order when confirming answers $_tag",
  (failure) =>
    Effect.gen(function* () {
      const { client, store } = deviceAnswering(
        () => draftOf(pedroPayment(), pedroProfile),
        (call) => (call === 3 ? Option.some(failure) : Option.none()),
      );

      const review = yield* reviewed(client, toPedro);

      expect(yield* Effect.promise(() => client.confirm(review))).toEqual(
        failure,
      );

      const kept = Option.getOrThrow(yield* store.read().pipe(Effect.orDie));

      expect(kept.transfer?.id).toBe(review.order.id);
      expect(kept.approvedUntil).toBeDefined();
    }),
);

const approvedReview = Effect.fn(function* (
  device: ReturnType<typeof deviceAnswering>,
) {
  const review = yield* reviewed(device.client, toPedro);

  const wallet = Option.getOrThrow(
    yield* device.store.read().pipe(Effect.orDie),
  );

  yield* device.store
    .write(new DeviceWallet({ ...wallet, approvedUntil: now() + 120 }))
    .pipe(Effect.orDie);

  return review;
});

const receiptFields = (review: PaymentReview) => ({
  id: review.order.id,
  to: review.order.to,
  recipient: pedroProfile,
  asset: review.order.asset,
  amount: review.order.amount,
});

it.effect("follows an approved order past many Pending answers", () =>
  Effect.gen(function* () {
    let shown: Option.Option<PaymentReview> = Option.none();

    const device = deviceAnswering((_, call) =>
      call === 1 || Option.isNone(shown)
        ? draftOf(pedroPayment(), pedroProfile)
        : call < 16
          ? new Pending({
              ...receiptFields(shown.value),
              expiresAt: DateTime.makeUnsafe((now() + 120) * 1000),
            })
          : new NotOpened(),
    );

    const review = yield* approvedReview(device);

    shown = Option.some(review);

    const following = yield* Effect.forkChild(
      device.effects.resume(review.order.id),
    );

    yield* TestClock.adjust("2 minutes");

    expect(yield* Fiber.join(following)).toEqual(new NotOpened());
    expect(device.approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

it.effect(
  "answers the recorded receipt after the device forgot the order",
  () =>
    Effect.gen(function* () {
      let settled: Option.Option<Settled> = Option.none();

      const device = deviceAnswering(
        () => draftOf(pedroPayment(), pedroProfile),
        () => Option.none(),
        () =>
          Effect.succeed(
            new Holding({
              profile: pedroProfile,
              reserveSponsor: Option.some(sponsor),
              balances: [],
              claimable: [],
              latest: settled,
            }),
          ),
      );

      const review = yield* reviewed(device.client, toPedro);

      settled = Option.some(
        new Settled({
          ...receiptFields(review),
          settledAt: DateTime.makeUnsafe(Date.now()),
        }),
      );

      expect(
        yield* Effect.promise(() => device.client.resume(review.order.id)),
      ).toEqual(Option.getOrThrow(settled));
    }),
);

it.effect("answers a failed receipt lookup as that failure", () =>
  Effect.gen(function* () {
    const device = deviceAnswering(
      () => draftOf(pedroPayment(), pedroProfile),
      () => Option.none(),
      () => Effect.fail(new Offline()),
    );

    const review = yield* reviewed(device.client, toPedro);

    expect(
      yield* Effect.promise(() => device.client.resume(review.order.id)),
    ).toEqual(new Offline());
  }),
);

it.effect("stops following a payment still Pending after it expired", () =>
  Effect.gen(function* () {
    let shown: Option.Option<PaymentReview> = Option.none();

    const device = deviceAnswering((_, call) =>
      call === 1 || Option.isNone(shown)
        ? draftOf(pedroPayment(), pedroProfile)
        : new Pending({
            ...receiptFields(shown.value),
            expiresAt: DateTime.makeUnsafe(120_000),
          }),
    );

    const review = yield* approvedReview(device);

    shown = Option.some(review);

    const following = yield* Effect.forkChild(
      device.effects.resume(review.order.id),
    );

    yield* TestClock.adjust("3 minutes");

    expect(following.pollUnsafe()).toBeUndefined();

    yield* TestClock.adjust("10 minutes");

    expect((yield* Fiber.join(following))._tag).toBe("Pending");
    expect(device.approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);
