import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  AddressRecipient,
  ExternalRecipient,
  Holding,
  NativeAsset,
  Offline,
  Profile,
  Settled,
  type UnsignedEnvelope,
} from "../src/contract";
import {
  DraftRejected,
  TransferIntent,
  makeWalletEffects,
} from "../src/device/client";
import { DeviceWallet, type KeyStore } from "../src/device/key-store";
import { nowSeconds, transferDraftOf, unusedPort } from "./device-fixtures";
import {
  approvingDevice,
  installSealedWallet,
  sealedKeyStore,
} from "./sealed-wallet-fixtures";
import { assertTagged } from "./tagged";
import {
  actors,
  amount,
  claimable,
  memoryDrafting,
  otherAmount,
  otherMemo,
  passkeys,
  payment,
  reviewed,
  sealedDrafting,
  toExchange,
  toMuxed,
  toPedro,
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

const mismatches: ReadonlyArray<
  readonly [string, TransferIntent, () => UnsignedEnvelope]
> = [
  [
    "a claimable for an external address",
    new TransferIntent({
      ...toPedro,
      to: AddressRecipient.make({ value: actors.pedro }),
    }),
    () => claimable(actors.pedro),
  ],
  [
    "a payment from another account",
    toExchange,
    () => payment(actors.stranger),
  ],
  [
    "a payment to the base account of a muxed destination",
    toMuxed,
    () => actors.payment({ to: actors.exchange, amount }),
  ],
  [
    "a payment to another muxed ID",
    toMuxed,
    () => actors.payment({ to: actors.muxed("2"), amount }),
  ],
  [
    "a payment to another address",
    new TransferIntent({
      ...toExchange,
      to: AddressRecipient.make({ value: actors.stranger }),
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
  ["a claimable to another address", toPedro, () => claimable(actors.stranger)],
  [
    "a claimable sponsored by another reserve sponsor",
    toPedro,
    () => claimable(actors.pedro, actors.stranger),
  ],
];

it.live.each(mismatches)("refuses %s", ([, intent, envelope]) =>
  Effect.gen(function* () {
    const { approvals, client } = deviceWith(envelope);

    expect(yield* client.review(intent)).toEqual(new DraftRejected());
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

it.live("reviews a draft paying the ordered muxed destination", () =>
  Effect.gen(function* () {
    const { client } = deviceWith(() =>
      actors.payment({ to: actors.muxed("1"), amount }),
    );

    expect((yield* reviewed(client, toMuxed)).to).toBe(actors.muxed("1"));
  }),
);

it.live.each([
  ["the draft", { lifetime: 10 }, () => payment()],
  ["its envelope", {}, () => payment(actors.sender, 10)],
] as const)(
  "asks once for a fresh draft without a prompt when %s expires within the approval margin",
  ([, options, envelope]) =>
    Effect.gen(function* () {
      const { approvals, auth, client } = yield* sealedWith(envelope, options);

      const redrafted = yield* client.confirm(
        yield* reviewed(client, toExchange),
      );

      assertTagged(redrafted, "PaymentReview");
      expect(redrafted.redrafted).toBe(true);
      expect(yield* client.confirm(redrafted)).toEqual(new DraftRejected());
      expect(approvals).toEqual([Option.none(), Option.none()]);
      expect(auth.requested).toEqual([]);
    }),
);

it.live("signs only one draft for an order", () =>
  Effect.gen(function* () {
    const { approvals, client } = yield* sealedWith(() => payment());

    const outcome = yield* client.confirm(yield* reviewed(client, toExchange));

    expect(outcome._tag).toBe("ApprovalOutstanding");
    expect(approvals.filter(Option.isSome)).toHaveLength(1);
  }),
);

it.live.each([
  ["after first settles and clears", false],
  ["after first settles and an unrelated signed order is stored", true],
] as const)(
  "two concurrent reviews for the same intent submit at most one order %s",
  ([, storeSignedOther]) =>
    Effect.gen(function* () {
      const { auth } = yield* installSealedWallet(actors.wallet);
      const secondObservedEmpty = yield* Latch.make();
      const firstSettled = yield* Latch.make();
      const pedroSubmissions: Array<string> = [];
      let otherOrderId: string | undefined;

      const delayedStore: KeyStore = {
        ...sealedKeyStore,
        readPublic: () =>
          sealedKeyStore
            .readPublic()
            .pipe(Effect.tap(() => secondObservedEmpty.open)),
        updatePublic: (update) =>
          firstSettled.await.pipe(
            Effect.andThen(sealedKeyStore.updatePublic(update)),
          ),
      };

      const port = unusedPort({
        transfer: (order, approval) =>
          Effect.gen(function* () {
            if (Predicate.isTagged(order.to, "Address")) {
              if (Option.isSome(approval)) {
                otherOrderId = order.id;

                return yield* Effect.fail(new Offline());
              }

              const at = nowSeconds();

              return transferDraftOf(
                payment(actors.sender, 120, at),
                new ExternalRecipient({ address: actors.exchange }),
                120,
                at,
              );
            }

            if (Option.isSome(approval)) {
              pedroSubmissions.push(order.id);

              return new Settled({
                id: order.id,
                to: order.to,
                recipient: actors.pedroProfile,
                asset: order.asset,
                amount: order.amount,
                settledAt: DateTime.makeUnsafe(Date.now()),
              });
            }

            const at = nowSeconds();

            return transferDraftOf(
              actors.payment({ to: actors.pedro, amount, at }),
              actors.pedroProfile,
              120,
              at,
            );
          }),
      });

      const firstClient = makeWalletEffects(
        port,
        sealedKeyStore,
        passkeys,
        approvingDevice(auth),
      );

      const secondClient = makeWalletEffects(port, delayedStore, passkeys);
      const second = yield* Effect.forkChild(secondClient.review(toPedro));

      yield* secondObservedEmpty.await;

      const firstOutcome = yield* firstClient.confirm(
        yield* reviewed(firstClient, toPedro),
      );

      if (storeSignedOther)
        yield* firstClient.confirm(yield* reviewed(firstClient, toExchange));

      yield* firstSettled.open;

      const secondOutcome = yield* Fiber.join(second);
      const stored = Option.getOrThrow(yield* sealedKeyStore.readPublic());

      expect(pedroSubmissions).toHaveLength(1);
      expect(firstOutcome._tag).toBe("Settled");
      expect(secondOutcome._tag).toBe("DraftRejected");
      expect(stored.transfer?.id).toBe(otherOrderId);
    }),
);

it.live(
  "a second tab confirming the same order after it settled submits nothing",
  () =>
    Effect.gen(function* () {
      const submissions: Array<string> = [];
      const { auth } = yield* installSealedWallet(actors.wallet);

      const port = unusedPort({
        transfer: (order, approval) =>
          Effect.sync(() => {
            if (Option.isSome(approval)) {
              submissions.push(order.id);

              return new Settled({
                id: order.id,
                to: order.to,
                recipient: actors.pedroProfile,
                asset: order.asset,
                amount: order.amount,
                settledAt: DateTime.makeUnsafe(Date.now()),
              });
            }

            const at = nowSeconds();

            return transferDraftOf(
              actors.payment({ to: actors.pedro, amount, at }),
              actors.pedroProfile,
              120,
              at,
            );
          }),
      });

      const tab = () =>
        makeWalletEffects(
          port,
          sealedKeyStore,
          passkeys,
          approvingDevice(auth),
        );

      const first = tab();
      const second = tab();
      const firstReview = yield* reviewed(first, toPedro);
      const secondReview = yield* reviewed(second, toPedro);

      expect(secondReview.order.id).toBe(firstReview.order.id);
      expect((yield* first.confirm(firstReview))._tag).toBe("Settled");
      expect((yield* second.confirm(secondReview))._tag).toBe("DraftRejected");
      expect(submissions).toEqual([firstReview.order.id]);
      expect(auth.requested).toHaveLength(1);
    }),
);

it.live(
  "overview storing the reserve sponsor preserves a concurrent transfer order and approval",
  () =>
    Effect.gen(function* () {
      const { auth } = yield* installSealedWallet(
        new DeviceWallet({ ...actors.wallet, reserveSponsor: undefined }),
      );

      const overviewReading = yield* Latch.make();
      const releaseOverview = yield* Latch.make();

      const port = unusedPort({
        overview: () =>
          overviewReading.open.pipe(
            Effect.andThen(releaseOverview.await),
            Effect.as(
              new Holding({
                profile: new Profile({
                  address: actors.sender,
                  username: actors.wallet.username,
                }),
                reserveSponsor: Option.some(actors.sponsor),
                balances: [],
                claimable: [],
                latest: Option.none(),
              }),
            ),
          ),
        transfer: (_order, approval) =>
          Option.isSome(approval)
            ? Effect.fail(new Offline())
            : Effect.sync(() => {
                const at = nowSeconds();

                return transferDraftOf(
                  actors.payment({ to: actors.pedro, amount, at }),
                  actors.pedroProfile,
                  120,
                  at,
                );
              }),
      });

      const client = makeWalletEffects(
        port,
        sealedKeyStore,
        passkeys,
        approvingDevice(auth),
      );

      const loadingOverview = yield* Effect.forkChild(client.overview());

      yield* overviewReading.await;
      expect(yield* client.confirm(yield* reviewed(client, toPedro))).toEqual(
        new Offline(),
      );

      const afterSend = Option.getOrThrow(yield* sealedKeyStore.readPublic());

      yield* releaseOverview.open;
      expect((yield* Fiber.join(loadingOverview))._tag).toBe("Holding");

      const afterOverview = Option.getOrThrow(
        yield* sealedKeyStore.readPublic(),
      );

      expect(afterSend.approvedUntil).toBeDefined();
      expect(afterOverview.reserveSponsor).toBe(actors.sponsor);
      expect(afterOverview.transfer?.id).toBe(afterSend.transfer?.id);
      expect(afterOverview.approvedUntil).toBe(afterSend.approvedUntil);
    }),
);
