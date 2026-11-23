import { expect, it } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
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
  BalanceId,
  ExternalRecipient,
  Holding,
  LinkRecipient,
  Offline,
  OpenPaymentLinks,
  PaymentLinkReceipt,
  PaymentLinkRecipient,
  PaymentMemo,
  Pending,
  PositiveAmount,
  Profile,
  ResolvedPaymentLink,
  Settled,
  TransferId,
  TransferOrder,
  type TransferStep,
  Username,
  UsernameRecipient,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import type { AssertionCeremony } from "../src/device/assertion";
import {
  PasskeyFailed,
  type Passkeys,
  PaymentLinkIntent,
  PaymentReview,
  SavedWallet,
  TransferIntent,
  UnsupportedDevice,
  makeWalletEffects,
} from "../src/device/client";
import {
  DeviceWallet,
  type KeyStore,
  KeyStoreUnavailable,
  PublicDeviceWallet,
} from "../src/device/key-store";
import {
  addressOf,
  memoryKeyStore,
  nowSeconds,
  sendActors,
  transferDraftOf,
  unusedPort,
} from "./device-fixtures";
import {
  approvingDevice,
  installSealedWallet,
  sealedKeyStore,
} from "./sealed-wallet-fixtures";
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

const storedWallet = Effect.map(sealedKeyStore.readPublic(), Option.getOrThrow);

const portAnswering = (
  answer: (
    order: TransferOrder,
    approval: Option.Option<Approval>,
    call: number,
  ) => Effect.Effect<TransferStep, Offline>,
  overview?: WalletPort["overview"],
) => {
  const approvals: Array<Option.Option<Approval>> = [];
  const orderIds: Array<string> = [];

  const transfer: WalletPort["transfer"] = (order, approval) =>
    Effect.suspend(() => {
      approvals.push(approval);
      orderIds.push(order.id);

      return answer(order, approval, approvals.length);
    });

  const port = overview
    ? unusedPort({ overview, transfer })
    : unusedPort({ transfer });

  return { approvals, orderIds, port };
};

const reviewingDevice = (...args: Parameters<typeof portAnswering>) => {
  const { approvals, port } = portAnswering(...args);
  const store = memoryKeyStore(Option.some(actors.wallet));

  return {
    approvals,
    store,
    client: makeWalletEffects(port, store, passkeys),
  };
};

const confirmingDevice = Effect.fn(function* (
  answer: Parameters<typeof portAnswering>[0],
  duringPrompt: Effect.Effect<void> = Effect.void,
) {
  const { approvals, orderIds, port } = portAnswering(answer);
  const callsAtPrompt: Array<number> = [];
  const { auth } = yield* installSealedWallet(actors.wallet);

  const ceremony: AssertionCeremony = {
    assert: (request) =>
      Effect.sync(() => callsAtPrompt.push(approvals.length)).pipe(
        Effect.andThen(duringPrompt),
        Effect.andThen(auth.assertions.assert(request)),
      ),
  };

  return {
    approvals,
    orderIds,
    callsAtPrompt,
    auth,
    client: makeWalletEffects(port, sealedKeyStore, passkeys, {
      ...approvingDevice(auth),
      ceremony,
    }),
  };
});

const reviewed = Effect.fn(function* (
  client: ReturnType<typeof makeWalletEffects>,
  intent: TransferIntent,
) {
  const outcome = yield* client.review(intent);

  assertTagged(outcome, "PaymentReview");

  return outcome;
});

const markApproved = (store: KeyStore) =>
  store
    .updatePublic((current) =>
      Option.some(
        new PublicDeviceWallet({
          ...current,
          approvedUntil: nowSeconds() + 120,
        }),
      ),
    )
    .pipe(Effect.orDie);

it.live("reviews the envelope's facts without approving the draft", () =>
  Effect.gen(function* () {
    const { approvals, client } = reviewingDevice(() =>
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

it.live(
  "approves the reviewed order once under the same id after its own prompt, never on entry or a cancelled prompt",
  () =>
    Effect.gen(function* () {
      const { approvals, orderIds, callsAtPrompt, auth, client } =
        yield* confirmingDevice((order, approval) =>
          Effect.succeed(
            Option.isSome(approval) ? settledFor(order) : pedroDraft(),
          ),
        );

      const review = yield* reviewed(client, toPedro);

      expect(review).toMatchObject({ to: actors.pedro, username: "pedro" });
      expect((yield* client.unlock())._tag).toBe("Unlocked");

      auth.cancels = true;
      expect((yield* client.confirm(review))._tag).toBe("PasskeyCancelled");
      expect((yield* storedWallet).approvedUntil).toBeUndefined();

      auth.cancels = false;
      expect(yield* client.confirm(review)).toBeInstanceOf(Settled);
      expect(approvals.filter(Option.isSome)).toHaveLength(1);
      expect(callsAtPrompt).toEqual([1, 1, 1]);
      expect(new Set(orderIds)).toEqual(new Set([review.order.id]));
    }),
);

it.live.each([
  ["a claimable", () => pedroClaimable()],
  [
    "a payment with the same facts and another sequence",
    () =>
      transferDraftOf(
        actors.payment({ to: actors.pedro, amount, sequence: "200" }),
        actors.pedroProfile,
      ),
  ],
] as const)(
  "refuses a review whose draft was swapped for %s",
  ([, swappedDraft]) =>
    Effect.gen(function* () {
      const { approvals, callsAtPrompt, client } = yield* confirmingDevice(() =>
        Effect.succeed(pedroDraft()),
      );

      const review = yield* reviewed(client, toPedro);

      const swapped = new PaymentReview({ ...review, draft: swappedDraft() });

      expect((yield* client.confirm(swapped))._tag).toBe("DraftRejected");
      expect(approvals.filter(Option.isSome)).toHaveLength(0);
      expect(callsAtPrompt).toEqual([]);
    }),
);

it.live(
  "refuses a confirmation whose order another tab replaced during the prompt",
  () =>
    Effect.gen(function* () {
      const replacing = makeWalletEffects(
        unusedPort({ transfer: () => Effect.succeed(exchangeDraft()) }),
        sealedKeyStore,
        passkeys,
      );

      const { approvals, client } = yield* confirmingDevice(
        () => Effect.succeed(pedroDraft()),
        replacing.review(toExchange).pipe(Effect.asVoid),
      );

      const review = yield* reviewed(client, toPedro);

      expect((yield* client.confirm(review))._tag).toBe("DraftRejected");
      expect(approvals.filter(Option.isSome)).toHaveLength(0);

      const kept = yield* storedWallet;

      expect(kept.transfer?.to).toEqual(toExchange.to);
      expect(kept.approvedUntil).toBeUndefined();
    }),
);

it.live(
  "resume ignores an unapproved draft and reports an unsubmitted approval as outstanding",
  () =>
    Effect.gen(function* () {
      const { approvals, client, store } = reviewingDevice(
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
    const { client } = yield* confirmingDevice((_o, approval) =>
      Option.isSome(approval)
        ? Effect.fail(new Offline())
        : Effect.succeed(pedroDraft()),
    );

    const review = yield* reviewed(client, toPedro);

    expect(yield* client.confirm(review)).toEqual(new Offline());
    const kept = yield* storedWallet;

    expect(kept.transfer?.id).toBe(review.order.id);
    expect(kept.approvedUntil).toBeDefined();
  }),
);

it.effect(
  "follows an approved order past many Pending answers until settled",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());

      const device = reviewingDevice((order, _a, call) =>
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

      const device = reviewingDevice(
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
    yield* TestClock.setTime(Date.now());

    const device = reviewingDevice((order, _a, call) =>
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

it.live(
  "reads status, overview, links, reviews and resumes orders without secret or passkey access, and fails closed on any signature",
  () =>
    Effect.gen(function* () {
      const linkAddress = addressOf(Keypair.random());

      const linkBalance = Schema.decodeSync(BalanceId)(
        `00000000${"c".repeat(64)}`,
      );

      const linkOrder = new TransferOrder({
        id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
        from: actors.sender,
        to: PaymentLinkRecipient.make({ value: linkAddress }),
        asset: baseAsset,
        amount,
      });

      const linkReceipt = new PaymentLinkReceipt({
        network: "testnet",
        address: linkAddress,
        asset: baseAsset,
        amount,
        balance: linkBalance,
        attempts: [linkBalance],
      });

      const approvedUntil = nowSeconds() + 120;
      const staleUsername = Schema.decodeSync(Username)("mariaold");

      const backing = memoryKeyStore(
        Option.some(
          new DeviceWallet({
            ...actors.wallet,
            username: staleUsername,
            reserveSponsor: undefined,
            transfer: linkOrder,
            approvedUntil,
            linkReceipt,
          }),
        ),
      );

      const lockedStore: KeyStore = {
        read: () =>
          Effect.fail(new KeyStoreUnavailable({ cause: "secret locked" })),
        write: () =>
          Effect.fail(new KeyStoreUnavailable({ cause: "secret locked" })),
        readPublic: () => backing.readPublic(),
        updatePublic: (update) => backing.updatePublic(update),
      };

      const lockedPasskeys: Passkeys = {
        register: () => Effect.fail(new PasskeyFailed()),
        authenticate: () => Effect.fail(new PasskeyFailed()),
      };

      const approvals: Array<Option.Option<Approval>> = [];
      let settleResume = false;

      const senderProfile = new Profile({
        address: actors.sender,
        username: actors.wallet.username,
      });

      const port = unusedPort({
        overview: () =>
          Effect.succeed(
            new Holding({
              profile: senderProfile,
              reserveSponsor: Option.some(actors.sponsor),
              balances: [],
              claimable: [],
              latest: Option.none(),
            }),
          ),
        paymentLinks: () => Effect.succeed(new OpenPaymentLinks({ links: [] })),
        resolvePaymentLink: () =>
          Effect.succeed(
            new ResolvedPaymentLink({
              balance: linkBalance,
              address: linkAddress,
              asset: baseAsset,
              amount,
            }),
          ),
        transfer: (order, approval) =>
          Effect.sync(() => {
            approvals.push(approval);

            if (Predicate.isTagged(order.to, "PaymentLink"))
              return transferDraftOf(
                actors.paymentLink({ to: order.to.value, amount }),
                new LinkRecipient({
                  kind: "paymentLink",
                  address: order.to.value,
                }),
              );

            return settleResume ? settledFor(order) : exchangeDraft();
          }),
      });

      const client = makeWalletEffects(port, lockedStore, lockedPasskeys);

      expect(yield* client.saved()).toEqual(
        new SavedWallet({
          username: staleUsername,
          openingApproved: false,
          backup: "stored",
        }),
      );

      assertTagged(yield* client.overview(), "Holding");

      const afterOverview = Option.getOrThrow(yield* lockedStore.readPublic());

      expect(afterOverview.username).toBe(actors.wallet.username);
      expect(afterOverview.reserveSponsor).toBe(actors.sponsor);
      expect(afterOverview.transfer?.id).toBe(linkOrder.id);
      expect(afterOverview.approvedUntil).toBe(approvedUntil);
      expect(afterOverview.linkReceipt?.balance).toBe(linkBalance);

      expect(yield* client.paymentLinks()).toEqual(
        new OpenPaymentLinks({ links: [] }),
      );

      assertTagged(yield* client.resolvePaymentLink(), "ResolvedPaymentLink");

      const afterResolve = Option.getOrThrow(yield* lockedStore.readPublic());

      expect(afterResolve.transfer).toBeUndefined();
      expect(afterResolve.approvedUntil).toBeUndefined();
      expect(afterResolve.linkReceipt).toBeUndefined();
      expect(afterResolve.reserveSponsor).toBe(actors.sponsor);

      expect(
        yield* client.createPaymentLink(
          new PaymentLinkIntent({ asset: baseAsset, amount }),
        ),
      ).toEqual(new UnsupportedDevice());

      const review = yield* reviewed(client, toExchange);

      expect(yield* client.confirm(review)).toEqual(new UnsupportedDevice());
      expect(
        Option.getOrThrow(yield* lockedStore.readPublic()).approvedUntil,
      ).toBeUndefined();

      yield* lockedStore.updatePublic((current) =>
        Option.some(
          new PublicDeviceWallet({
            ...current,
            approvedUntil: nowSeconds() + 120,
          }),
        ),
      );

      expect((yield* client.resume(review.order.id))._tag).toBe(
        "ApprovalOutstanding",
      );

      settleResume = true;
      assertTagged(yield* client.resume(review.order.id), "Settled");
      expect(
        Option.getOrThrow(yield* lockedStore.readPublic()).transfer,
      ).toBeUndefined();
      expect(approvals.filter(Option.isSome)).toHaveLength(0);
    }),
);
