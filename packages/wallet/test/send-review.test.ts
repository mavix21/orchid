import { expect, it } from "@effect/vitest";
import { Account, Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
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
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { TransferIntent, makeWalletClient } from "../src/device/client";
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
    overview: unused,
    open: unused,
    manage: unused,
    passkeyChallenge: unused,
    enroll: unused,
    restore: unused,
    transfer: (order, approval) =>
      Effect.sync(() => {
        approvals.push(approval);
        orderIds.push(order.id);

        return answer(approval, approvals.length);
      }),
  };

  const client = makeWalletClient(
    port,
    store,
    new SoftwareAuthenticator("http://localhost:3000").passkeys,
  );

  return { approvals, orderIds, client, store };
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
    const { approvals, client, store } = deviceAnswering((approval, call) =>
      Option.isSome(approval) || call > 1
        ? new NotOpened()
        : draftOf(pedroPayment(), pedroProfile),
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
