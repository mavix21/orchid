import { expect, it } from "@effect/vitest";
import { Account, Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AddressRecipient,
  type Approval,
  ExternalRecipient,
  NativeAsset,
  NotOpened,
  PaymentMemo,
  PositiveAmount,
  Profile,
  type ResolvedRecipient,
  SigningRequest,
  TransferDraft,
  TransferId,
  TransferOrder,
  type TransferStep,
  Pending,
  type UnsignedEnvelope,
  Username,
  UsernameRecipient,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import {
  DraftRejected,
  TransferIntent,
  makeWalletClient,
} from "../src/device/client";
import { DeviceWallet, type KeyStore } from "../src/device/key-store";
import { generateSecretPhrase } from "../src/device/secret-phrase";
import { signingKey } from "../src/device/signing";
import { draftClaimable } from "../src/stellar/asset-envelopes";
import { draftPayment } from "../src/stellar/envelopes";
import { addressOf } from "./wallet-harness";
import { SoftwareAuthenticator } from "./software-authenticator";

const phrase = generateSecretPhrase();
const sender = addressOf(signingKey(phrase));
const sponsor = addressOf(Keypair.random());
const stranger = addressOf(Keypair.random());
const exchange = addressOf(Keypair.random());
const pedro = addressOf(Keypair.random());
const amount = Schema.decodeSync(PositiveAmount)("10000000");
const otherAmount = Schema.decodeSync(PositiveAmount)("20000000");

const memo = Schema.decodeSync(PaymentMemo)({ type: "text", value: "deposit" });

const otherMemo = Schema.decodeSync(PaymentMemo)({ type: "id", value: "7" });

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

const payment = (source = sender, lifetime = 120) =>
  draftPayment({
    source: new Account(source, "100"),
    to: exchange,
    asset: baseAsset,
    amount,
    memo,
    minTime: now(),
    maxTime: now() + lifetime,
  });

const claimable = (source = sender) =>
  draftClaimable({
    source: new Account(source, "100"),
    reserveSponsor: sponsor,
    to: pedro,
    asset: baseAsset,
    amount,
    minTime: now(),
    maxTime: now() + 120,
  });

const deviceWith = (
  envelope: () => UnsignedEnvelope,
  lifetime = 120,
  answer: (approval: Option.Option<Approval>) => Option.Option<TransferStep> = (
    approval,
  ) => (Option.isSome(approval) ? Option.some(new NotOpened()) : Option.none()),
) => {
  const approvals: Array<Option.Option<Approval>> = [];

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

  const recipientOf = (order: TransferOrder) =>
    Match.valueTags(order.to, {
      Username: (): ResolvedRecipient => pedroProfile,
      Address: () => new ExternalRecipient({ address: exchange }),
      Phone: () => new ExternalRecipient({ address: exchange }),
    });

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

        return Option.getOrElse(
          answer(approval),
          () =>
            new TransferDraft({
              request: new SigningRequest({
                envelope: envelope(),
                expiresAt: DateTime.makeUnsafe((now() + lifetime) * 1000),
              }),
              recipient: recipientOf(order),
              memoRequired: false,
            }),
        );
      }),
  };

  const client = makeWalletClient(
    port,
    store,
    new SoftwareAuthenticator("http://localhost:3000").passkeys,
  );

  return { approvals, client, store };
};

it.effect("signs a live draft whose facts match the order", () =>
  Effect.gen(function* () {
    const { approvals, client } = deviceWith(() => payment());

    expect(yield* Effect.promise(() => client.send(toExchange))).toEqual(
      new NotOpened(),
    );
    expect(approvals.filter(Option.isSome)).toHaveLength(1);
  }),
);

const mismatches: Array<[string, TransferIntent, () => UnsignedEnvelope]> = [
  [
    "a payment whose envelope expires before the draft says",
    toExchange,
    () => payment(sender, 10),
  ],
  [
    "a claimable for an external address",
    new TransferIntent({
      ...toPedro,
      to: AddressRecipient.make({ value: pedro }),
    }),
    () => claimable(),
  ],
  ["a payment from another account", toExchange, () => payment(stranger)],
  [
    "a payment to another address",
    new TransferIntent({
      ...toExchange,
      to: AddressRecipient.make({ value: stranger }),
    }),
    () => payment(),
  ],
  [
    "a payment of another asset",
    new TransferIntent({ ...toExchange, asset: NativeAsset.make({}) }),
    () => payment(),
  ],
  [
    "a payment of another amount",
    new TransferIntent({ ...toExchange, amount: otherAmount }),
    () => payment(),
  ],
  [
    "a payment with another memo",
    new TransferIntent({ ...toExchange, memo: otherMemo }),
    () => payment(),
  ],
  ["a claimable from another account", toPedro, () => claimable(stranger)],
  [
    "a claimable to another address",
    toPedro,
    () =>
      draftClaimable({
        source: new Account(sender, "100"),
        reserveSponsor: sponsor,
        to: stranger,
        asset: baseAsset,
        amount,
        minTime: now(),
        maxTime: now() + 120,
      }),
  ],
  [
    "a claimable of another asset",
    new TransferIntent({ ...toPedro, asset: NativeAsset.make({}) }),
    () => claimable(),
  ],
  [
    "a claimable of another amount",
    new TransferIntent({ ...toPedro, amount: otherAmount }),
    () => claimable(),
  ],
  [
    "a claimable sponsored by another reserve sponsor",
    toPedro,
    () =>
      draftClaimable({
        source: new Account(sender, "100"),
        reserveSponsor: stranger,
        to: pedro,
        asset: baseAsset,
        amount,
        minTime: now(),
        maxTime: now() + 120,
      }),
  ],
];

for (const [draft, intent, envelope] of mismatches)
  it.effect(`refuses ${draft}`, () =>
    Effect.gen(function* () {
      const { approvals, client } = deviceWith(envelope);

      expect(yield* Effect.promise(() => client.send(intent))).toEqual(
        new DraftRejected(),
      );
      expect(approvals.filter(Option.isSome)).toHaveLength(0);
    }),
  );

it.effect(
  "asks once for a fresh draft when the draft expires within the approval margin",
  () =>
    Effect.gen(function* () {
      const { approvals, client } = deviceWith(() => payment(), 10);

      expect(yield* Effect.promise(() => client.send(toExchange))).toEqual(
        new DraftRejected(),
      );
      expect(approvals).toEqual([Option.none(), Option.none()]);
    }),
);

it.effect("signs only one draft for an order", () =>
  Effect.gen(function* () {
    const { approvals, client } = deviceWith(
      () => payment(),
      120,
      () => Option.none(),
    );

    expect(yield* Effect.promise(() => client.send(toExchange))).toEqual(
      new DraftRejected(),
    );
    expect(approvals.filter(Option.isSome)).toHaveLength(1);
  }),
);

it.effect(
  "keeps a signed order whose signature expired while the server reports it pending",
  () =>
    Effect.gen(function* () {
      const signed = new TransferOrder({
        ...toExchange,
        id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
        from: sender,
      });

      const inFlight = new Pending({
        ...signed,
        recipient: new ExternalRecipient({ address: exchange }),
        expiresAt: DateTime.makeUnsafe(Date.now()),
      });

      const { approvals, client, store } = deviceWith(
        () => payment(),
        120,
        () => Option.some(inFlight),
      );

      const wallet = Option.getOrThrow(yield* store.read());

      yield* store.write(
        new DeviceWallet({
          ...wallet,
          transfer: signed,
          approvedUntil: now() - 3600,
        }),
      );

      expect(
        (yield* Effect.promise(() =>
          client.send(
            new TransferIntent({ ...toExchange, amount: otherAmount }),
          ),
        ))._tag,
      ).toBe("ApprovalOutstanding");
      expect(approvals).toEqual([Option.none()]);
      expect(Option.getOrThrow(yield* store.read()).transfer?.id).toBe(
        signed.id,
      );
    }),
);
