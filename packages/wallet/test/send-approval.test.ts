import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  AddressRecipient,
  type Approval,
  ExternalMemoRequired,
  ExternalRecipient,
  Holding,
  LinkRecipient,
  NativeAsset,
  Offline,
  PaymentMemo,
  Pending,
  PositiveAmount,
  Profile,
  type ResolvedRecipient,
  Settled,
  TransferId,
  TransferOrder,
  type TransferStep,
  type UnsignedEnvelope,
  UsernameRecipient,
  baseAsset,
} from "../src/contract";
import {
  DraftRejected,
  TransferIntent,
  makeWalletEffects,
} from "../src/device/client";
import {
  DeviceWallet,
  type KeyStore,
  PublicDeviceWallet,
} from "../src/device/key-store";
import {
  memoryKeyStore,
  nowSeconds,
  savedWallet,
  sendActors,
  transferDraftOf,
  unusedPort,
} from "./device-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";

const actors = sendActors();
const amount = Schema.decodeSync(PositiveAmount)("10000000");
const otherAmount = Schema.decodeSync(PositiveAmount)("20000000");
const memo = Schema.decodeSync(PaymentMemo)({ type: "text", value: "deposit" });
const otherMemo = Schema.decodeSync(PaymentMemo)({ type: "id", value: "7" });
const passkeys = new SoftwareAuthenticator("http://localhost:3000").passkeys;

const toExchange = new TransferIntent({
  to: AddressRecipient.make({ value: actors.exchange }),
  asset: baseAsset,
  amount,
  memo,
});

const toMuxed = new TransferIntent({
  to: AddressRecipient.make({ value: actors.muxed("1") }),
  asset: baseAsset,
  amount,
});

const toPedro = new TransferIntent({
  to: UsernameRecipient.make({ value: actors.pedroProfile.username }),
  asset: baseAsset,
  amount,
});

const payment = (source = actors.sender, lifetime = 120, at = nowSeconds()) =>
  actors.payment({ source, to: actors.exchange, amount, memo, lifetime, at });

const claimable = (to = actors.pedro, reserveSponsor = actors.sponsor) =>
  actors.claimable({ to, amount, reserveSponsor });

const deviceWith = (
  envelope: (at: number) => UnsignedEnvelope,
  options: {
    readonly lifetime?: number;
    readonly answer?: (
      approval: Option.Option<Approval>,
    ) => Option.Option<TransferStep>;
    readonly beforeWrite?: Effect.Effect<void>;
    readonly initial?: DeviceWallet;
  } = {},
) => {
  const approvals: Array<Option.Option<Approval>> = [];
  const orderIds: Array<string> = [];

  const store = memoryKeyStore(
    Option.some(options.initial ?? actors.wallet),
    options.beforeWrite,
  );

  const recipientOf = (order: TransferOrder) =>
    Match.valueTags(order.to, {
      Username: (): ResolvedRecipient => actors.pedroProfile,
      Address: ({ value }) => new ExternalRecipient({ address: value }),
      PaymentLink: ({ value }) =>
        new LinkRecipient({ kind: "paymentLink", address: value }),
      Phone: () => new ExternalRecipient({ address: actors.exchange }),
    });

  const port = unusedPort({
    transfer: (order, approval) =>
      Effect.map(Clock.currentTimeMillis, (millis) => {
        const at = Math.floor(millis / 1000);

        approvals.push(approval);
        orderIds.push(order.id);

        return Option.getOrElse(
          options.answer?.(approval) ?? Option.none(),
          () =>
            transferDraftOf(
              envelope(at),
              recipientOf(order),
              options.lifetime ?? 120,
              at,
            ),
        );
      }),
  });

  return {
    approvals,
    orderIds,
    client: makeWalletEffects(port, store, passkeys),
    store,
  };
};

const mismatches: ReadonlyArray<
  readonly [string, TransferIntent, () => UnsignedEnvelope]
> = [
  [
    "a payment whose envelope expires before the draft says",
    toExchange,
    () => payment(actors.sender, 10),
  ],
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

    expect(yield* client.send(intent)).toEqual(new DraftRejected());
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

it.live("signs a draft paying the ordered muxed destination", () =>
  Effect.gen(function* () {
    const { approvals, client } = deviceWith(() =>
      actors.payment({ to: actors.muxed("1"), amount }),
    );

    expect(yield* client.send(toMuxed)).toEqual(new DraftRejected());
    expect(approvals.filter(Option.isSome)).toHaveLength(1);
  }),
);

it.live(
  "asks once for a fresh draft when the draft expires within the approval margin",
  () =>
    Effect.gen(function* () {
      const { approvals, client } = deviceWith(() => payment(), {
        lifetime: 10,
      });

      expect(yield* client.send(toExchange)).toEqual(new DraftRejected());
      expect(approvals).toEqual([Option.none(), Option.none()]);
    }),
);

it.live("signs only one draft for an order", () =>
  Effect.gen(function* () {
    const { approvals, client } = deviceWith(() => payment());

    expect(yield* client.send(toExchange)).toEqual(new DraftRejected());
    expect(approvals.filter(Option.isSome)).toHaveLength(1);
  }),
);

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
        (yield* client.send(
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
      yield* client.send(
        new TransferIntent({ ...toExchange, amount: otherAmount }),
      ),
    ).toEqual(refusal);
    expect(orderIds).toHaveLength(2);
    expect(orderIds[0]).toBe(oldOrder.id);
    expect(orderIds[1]).not.toBe(oldOrder.id);
    expect((yield* savedWallet(store)).transfer?.id).toBe(orderIds[1]);
  }),
);

it.effect("rechecks the approval margin after recording the approval", () =>
  Effect.gen(function* () {
    const writing = yield* Latch.make();

    const { approvals, client } = deviceWith(
      (at) => payment(actors.sender, 21, at),
      {
        lifetime: 21,
        beforeWrite: writing.open.pipe(
          Effect.andThen(Effect.sleep("1500 millis")),
        ),
      },
    );

    const sending = yield* Effect.forkChild(client.send(toExchange));

    yield* writing.await;
    yield* TestClock.adjust("3000 millis");
    expect(yield* Fiber.join(sending)).toEqual(new DraftRejected());
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

it.live(
  "two concurrent sends for the same intent submit at most one order",
  () =>
    Effect.gen(function* () {
      const store = memoryKeyStore(Option.some(actors.wallet));
      const secondObservedEmpty = yield* Latch.make();
      const firstSettled = yield* Latch.make();
      const submittedIds: Array<string> = [];

      const delayedStore: KeyStore = {
        read: () => store.read(),
        write: (wallet) => store.write(wallet),
        readPublic: () =>
          store.readPublic().pipe(Effect.tap(() => secondObservedEmpty.open)),
        updatePublic: (update) =>
          firstSettled.await.pipe(Effect.andThen(store.updatePublic(update))),
      };

      const port = unusedPort({
        transfer: (order, approval) =>
          Effect.sync(() => {
            if (Option.isSome(approval)) {
              submittedIds.push(order.id);

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

      const firstClient = makeWalletEffects(port, store, passkeys);
      const secondClient = makeWalletEffects(port, delayedStore, passkeys);

      const second = yield* Effect.forkChild(secondClient.send(toPedro));

      yield* secondObservedEmpty.await;

      const firstOutcome = yield* firstClient.send(toPedro);

      yield* firstSettled.open;

      const secondOutcome = yield* Fiber.join(second);

      expect(submittedIds).toHaveLength(1);
      expect(firstOutcome._tag).toBe("Settled");
      expect(secondOutcome._tag).toBe("DraftRejected");
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

      const outcome = yield* makeWalletEffects(port, store, passkeys).send(
        new TransferIntent({ ...toExchange, amount: otherAmount }),
      );

      expect(outcome._tag).toBe("ApprovalOutstanding");

      const kept = Option.getOrThrow(yield* store.readPublic());

      expect(kept.transfer?.id).toBe(oldOrder.id);
      expect(kept.approvedUntil).toBe(renewedUntil);
    }),
);

it.live(
  "overview storing the reserve sponsor preserves a concurrent transfer order and approval",
  () =>
    Effect.gen(function* () {
      const store = memoryKeyStore(
        Option.some(
          new DeviceWallet({ ...actors.wallet, reserveSponsor: undefined }),
        ),
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

      const client = makeWalletEffects(port, store, passkeys);
      const loadingOverview = yield* Effect.forkChild(client.overview());

      yield* overviewReading.await;
      expect(yield* client.send(toPedro)).toEqual(new Offline());

      const afterSend = Option.getOrThrow(yield* store.readPublic());

      yield* releaseOverview.open;
      expect((yield* Fiber.join(loadingOverview))._tag).toBe("Holding");

      const afterOverview = Option.getOrThrow(yield* store.readPublic());

      expect(afterOverview.reserveSponsor).toBe(actors.sponsor);
      expect(afterOverview.transfer?.id).toBe(afterSend.transfer?.id);
      expect(afterOverview.approvedUntil).toBe(afterSend.approvedUntil);
    }),
);
