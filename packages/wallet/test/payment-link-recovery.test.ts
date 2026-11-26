import { expect, layer } from "@effect/vitest";
import { Claimant, Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  BalanceGone,
  BalanceId,
  Offline,
  PaymentLinkNotFound,
  PaymentLinkReceipt,
  PaymentLinkRecipient,
  PositiveAmount,
  RecipientCannotReceive,
  TransferOrder,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  DraftRejected,
  PaymentLinkIntent,
  type WalletEffects,
  makeWalletEffects,
} from "../src/device/client";
import { linkKeyOf } from "../src/device/link-code";
import { Transfers } from "../src/server/Transfers.server";
import {
  DeviceWallet,
  memoryKeyStore,
  savedWallet,
  signingKey,
} from "./device-fixtures";
import {
  approvingDevice,
  installSealedWallet,
  sealedKeyStore,
} from "./sealed-wallet-fixtures";
import { settleOnSubmit } from "./link-fixtures";
import { assertTagged } from "./tagged";
import {
  addressOf,
  amount,
  approve,
  devicePasskeys,
  euro,
  euroLine,
  holdingsFor,
  openSender,
  orderFor,
  settleHash,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const linkAmount = Schema.decodeSync(PositiveAmount)("10000000");

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect.each([
      {
        name: "resolving the receipt",
        reconcile: (client: WalletEffects) =>
          client
            .resolvePaymentLink()
            .pipe(
              Effect.map((resolved) =>
                Predicate.isTagged(resolved, "LatestPaymentLink")
                  ? resolved.savedOnDevice
                  : resolved._tag,
              ),
            ),
        reconciled: true,
      },
      {
        name: "starting another link before visiting the links",
        reconcile: (client: WalletEffects) =>
          client
            .reviewPaymentLink(
              new PaymentLinkIntent({
                asset: baseAsset,
                amount: linkAmount,
                saveOnDevice: false,
              }),
            )
            .pipe(Effect.map((reviewed) => reviewed._tag)),
        reconciled: "PaymentReview",
      },
    ])(
      "a restarted creation records the balance funded before an interrupted approval by $name and re-shares its link",
      ({ reconcile, reconciled }) =>
        Effect.gen(function* () {
          const store = memoryKeyStore();
          const { wallet, sender } = yield* openSender(store, "receiptowner");

          const interruptedPort: WalletPort = {
            ...wallet,
            transfer: (nextOrder, approval) =>
              Option.isSome(approval)
                ? settleOnSubmit(wallet, sender.address)(
                    nextOrder,
                    approval,
                  ).pipe(Effect.andThen(Effect.fail(new Offline())))
                : wallet.transfer(nextOrder, approval),
          };

          const { auth } = yield* installSealedWallet(sender);

          const interrupted = makeWalletEffects(
            interruptedPort,
            sealedKeyStore,
            devicePasskeys,
            approvingDevice(auth),
          );

          const review = yield* interrupted.reviewPaymentLink(
            new PaymentLinkIntent({
              asset: baseAsset,
              amount: linkAmount,
              saveOnDevice: true,
            }),
          );

          assertTagged(review, "PaymentReview");
          expect(yield* interrupted.confirmPaymentLink(review)).toEqual(
            new Offline(),
          );

          const savedAfterCrash = yield* savedWallet(sealedKeyStore);

          const funded = Option.getOrThrow(
            Option.fromNullishOr(savedAfterCrash.linkReceipt),
          );

          expect(funded.attempts).toHaveLength(1);
          expect(
            (yield* browserKeyStore.readLinks()).map((link) => ({
              address: link.address,
              fundedBalance: link.fundedBalance,
            })),
          ).toEqual([{ address: funded.address, fundedBalance: undefined }]);

          const restartedDevice = makeWalletEffects(
            wallet,
            sealedKeyStore,
            devicePasskeys,
            approvingDevice(auth),
          );

          world.holdings.set(
            sender.address,
            holdingsFor(sender.address, {
              lines: [{ ...euroLine("500000000"), asset: baseAsset }],
            }),
          );

          expect(yield* reconcile(restartedDevice)).toBe(reconciled);
          expect(
            (yield* browserKeyStore.readLinks()).map((link) => ({
              address: link.address,
              fundedBalance: link.fundedBalance,
            })),
          ).toEqual([
            { address: funded.address, fundedBalance: funded.balance },
          ]);

          const revealed = yield* restartedDevice.revealPaymentLink({
            address: funded.address,
            balance: funded.balance,
            asset: funded.asset,
            amount: funded.amount,
          });

          assertTagged(revealed, "PaymentLinkRevealed");
          expect(
            Option.map(linkKeyOf(revealed.code), ({ address }) => address),
          ).toEqual(Option.some(funded.address));
          expect(revealed.path).toBe(`/r#${revealed.code}`);

          const competingMiss = yield* wallet.resolvePaymentLink(
            sender.address,
            new PaymentLinkReceipt({
              network: "testnet",
              address: addressOf(Keypair.random()),
              asset: baseAsset,
              amount: linkAmount,
              balance: funded.balance,
              attempts: [funded.balance],
            }),
          );

          expect(competingMiss).toEqual(new PaymentLinkNotFound());
        }),
    );

    it.effect(
      "restarted device resolves a live balance while transfer reconciliation stays Pending, and preserves Pending when absent",
      () =>
        Effect.gen(function* () {
          const store = memoryKeyStore();
          const { wallet, sender } = yield* openSender(store, "pendinglink");

          const pendingPort: WalletPort = {
            ...wallet,
            transfer: (nextOrder, approval) =>
              Option.isSome(approval)
                ? wallet
                    .transfer(nextOrder, approval)
                    .pipe(Effect.andThen(Effect.fail(new Offline())))
                : wallet.transfer(nextOrder, approval),
          };

          const { auth } = yield* installSealedWallet(sender);

          const pending = makeWalletEffects(
            pendingPort,
            sealedKeyStore,
            devicePasskeys,
            approvingDevice(auth),
          );

          const review = yield* pending.reviewPaymentLink(
            new PaymentLinkIntent({
              asset: baseAsset,
              amount: linkAmount,
              saveOnDevice: true,
            }),
          );

          assertTagged(review, "PaymentReview");
          expect(yield* pending.confirmPaymentLink(review)).toEqual(
            new Offline(),
          );

          const linkAddr = review.to;
          const saved = yield* savedWallet(sealedKeyStore);

          const receipt = Option.getOrThrow(
            Option.fromNullishOr(saved.linkReceipt),
          );

          const restarted = makeWalletEffects(
            wallet,
            sealedKeyStore,
            devicePasskeys,
            approvingDevice(auth),
          );

          const savedFunding = Effect.map(
            browserKeyStore.readLinks(),
            (links) => links.map((link) => link.fundedBalance),
          );

          assertTagged(yield* restarted.resolvePaymentLink(), "Pending");
          expect(yield* savedFunding).toEqual([undefined]);
          expect(
            (yield* savedWallet(sealedKeyStore)).linkReceipt?.balance,
          ).toBe(receipt.balance);

          world.claimables.set(receipt.balance, {
            balance: receipt.balance,
            asset: baseAsset,
            amount: linkAmount,
            sponsored: true,
            claimants: [
              new Claimant(linkAddr, Claimant.predicateUnconditional()),
              new Claimant(sender.address, Claimant.predicateUnconditional()),
            ],
          });

          const resolved = yield* restarted.resolvePaymentLink();

          assertTagged(resolved, "LatestPaymentLink");
          expect(resolved.balance).toBe(receipt.balance);
          expect(resolved.address).toBe(linkAddr);
          expect(resolved.savedOnDevice).toBe(true);
          expect(yield* savedFunding).toEqual([receipt.balance]);

          const cancelSettlingPort: WalletPort = {
            ...wallet,
            manage: (order, approval) =>
              wallet.manage(order, approval).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    const sealed = world.submitted.at(-1);

                    if (Option.isSome(approval) && sealed) {
                      settleHash(sealed.hash);
                      world.claimables.delete(resolved.balance);
                    }
                  }),
                ),
              ),
          };

          const held = yield* Latch.make();
          const released = yield* Latch.make();
          let holdFirstPreflight = true;

          const holdingPort: WalletPort = {
            ...cancelSettlingPort,
            manage: (order, approval) => {
              if (!holdFirstPreflight || Option.isSome(approval))
                return cancelSettlingPort.manage(order, approval);

              holdFirstPreflight = false;

              return held.open.pipe(
                Effect.andThen(released.await),
                Effect.andThen(cancelSettlingPort.manage(order, approval)),
              );
            },
          };

          const reclaiming = makeWalletEffects(
            holdingPort,
            sealedKeyStore,
            devicePasskeys,
            approvingDevice(auth),
          );

          const lateReview = yield* Effect.forkChild(
            reclaiming.reviewReclaim(resolved),
          );

          yield* held.await;

          expect(
            yield* reclaiming.reviewReclaim({
              ...resolved,
              balance: Schema.decodeSync(BalanceId)(
                `00000000${"1".repeat(64)}`,
              ),
            }),
          ).toEqual(new BalanceGone({ status: "unresolved" }));
          expect(yield* savedFunding).toEqual([receipt.balance]);

          yield* released.open;

          expect(yield* Fiber.join(lateReview)).toEqual(new DraftRejected());

          const superseded = yield* reclaiming.reviewReclaim(resolved);
          const current = yield* reclaiming.reviewReclaim(resolved);
          const fundingPrompts = auth.requested.length;

          assertTagged(superseded, "ReclaimReview");
          assertTagged(current, "ReclaimReview");

          expect(yield* reclaiming.confirmReclaim(superseded)).toEqual(
            new DraftRejected(),
          );
          expect(auth.requested).toHaveLength(fundingPrompts);

          expect(yield* savedFunding).toEqual([receipt.balance]);
          assertTagged(
            yield* reclaiming.confirmReclaim(current),
            "AssetSettled",
          );
          expect(yield* savedFunding).toEqual([]);
          expect(auth.requested).toHaveLength(fundingPrompts + 1);
        }),
    );

    it.effect(
      "reclaim review checks sender receive capacity, marks an absent balance unresolved, and never hides an unsettled link",
      () =>
        Effect.gen(function* () {
          const store = memoryKeyStore();
          const { wallet, sender } = yield* openSender(store, "cancelowner");
          const linkAddr = addressOf(Keypair.random());

          const balance = Schema.decodeSync(BalanceId)(
            `00000000${"9".repeat(64)}`,
          );

          world.claimables.set(balance, {
            balance,
            asset: euro,
            amount: linkAmount,
            sponsored: true,
            claimants: [
              new Claimant(linkAddr, Claimant.predicateUnconditional()),
              new Claimant(sender.address, Claimant.predicateUnconditional()),
            ],
          });

          world.holdings.set(
            sender.address,
            holdingsFor(sender.address, {
              lines: [euroLine("0", { capacity: amount("9999999") })],
            }),
          );

          const client = makeWalletEffects(wallet, store, devicePasskeys);

          expect(
            yield* client.reviewReclaim({
              balance,
              asset: euro,
              amount: linkAmount,
            }),
          ).toEqual(
            new RecipientCannotReceive({
              address: sender.address,
              reason: "no_capacity",
            }),
          );

          world.claimables.delete(balance);

          expect(
            yield* client.reviewReclaim({
              balance,
              asset: euro,
              amount: linkAmount,
            }),
          ).toEqual(new BalanceGone({ status: "unresolved" }));

          world.holdings.delete(sender.address);

          const inflightLink = addressOf(Keypair.random());

          const inflightOrder = new TransferOrder({
            ...orderFor(
              Keypair.random(),
              PaymentLinkRecipient.make({ value: inflightLink }),
            ),
            from: sender.address,
          });

          const draft = yield* wallet.transfer(inflightOrder, Option.none());

          assertTagged(draft, "TransferDraft");

          const inflightBalance = Option.getOrThrow(
            Option.fromNullishOr(draft.claimable),
          );

          expect(
            yield* client.reviewReclaim({
              balance: inflightBalance,
              asset: baseAsset,
              amount: linkAmount,
            }),
          ).toEqual(new BalanceGone({ status: "unresolved" }));

          const senderKey = signingKey(sender.phrase);

          assertTagged(
            yield* wallet.transfer(
              inflightOrder,
              approve(draft.request, senderKey),
            ),
            "Pending",
          );

          yield* Transfers.use((t) => t.closeBalance(inflightBalance));

          const submitted = Option.getOrThrow(
            Option.fromNullishOr(world.submitted.at(-1)),
          );

          world.claimables.set(inflightBalance, {
            balance: inflightBalance,
            asset: baseAsset,
            amount: linkAmount,
            sponsored: true,
            claimants: [
              new Claimant(inflightLink, Claimant.predicateUnconditional()),
              new Claimant(sender.address, Claimant.predicateUnconditional()),
            ],
          });
          settleHash(submitted.hash);
          yield* sweep;

          const open = yield* wallet.paymentLinks(sender.address);

          assertTagged(open, "OpenPaymentLinks");
          expect(open.links.map((item) => item.balance)).toEqual([
            inflightBalance,
          ]);
        }),
    );

    it.effect(
      "stale recovery cleanup for link A does not erase a newer approved link B",
      () =>
        Effect.gen(function* () {
          const store = memoryKeyStore();
          const { wallet, sender } = yield* openSender(store, "raceowner");
          const linkA = addressOf(Keypair.random());
          const linkB = addressOf(Keypair.random());

          const balanceA = Schema.decodeSync(BalanceId)(
            `00000000${"a".repeat(64)}`,
          );

          const balanceB = Schema.decodeSync(BalanceId)(
            `00000000${"b".repeat(64)}`,
          );

          const orderA = new TransferOrder({
            ...orderFor(
              Keypair.random(),
              PaymentLinkRecipient.make({ value: linkA }),
            ),
            from: sender.address,
          });

          const orderB = new TransferOrder({
            ...orderFor(
              Keypair.random(),
              PaymentLinkRecipient.make({ value: linkB }),
            ),
            from: sender.address,
          });

          const receiptA = new PaymentLinkReceipt({
            network: "testnet",
            address: linkA,
            asset: baseAsset,
            amount: linkAmount,
            balance: balanceA,
            attempts: [balanceA],
          });

          const receiptB = new PaymentLinkReceipt({
            network: "testnet",
            address: linkB,
            asset: baseAsset,
            amount: linkAmount,
            balance: balanceB,
            attempts: [balanceB],
          });

          world.claimables.set(balanceA, {
            balance: balanceA,
            asset: baseAsset,
            amount: linkAmount,
            sponsored: true,
            claimants: [
              new Claimant(linkA, Claimant.predicateUnconditional()),
              new Claimant(sender.address, Claimant.predicateUnconditional()),
            ],
          });
          world.claimables.set(balanceB, {
            balance: balanceB,
            asset: baseAsset,
            amount: linkAmount,
            sponsored: true,
            claimants: [
              new Claimant(linkB, Claimant.predicateUnconditional()),
              new Claimant(sender.address, Claimant.predicateUnconditional()),
            ],
          });

          yield* store.seed(
            new DeviceWallet({
              ...sender,
              transfer: orderA,
              approvedUntil: Math.floor(Date.now() / 1000) + 120,
              linkReceipt: receiptA,
            }),
          );

          const started = yield* Latch.make();
          const release = yield* Latch.make();

          const heldPort: WalletPort = {
            ...wallet,
            resolvePaymentLink: (addr, receipt) =>
              started.open.pipe(
                Effect.andThen(release.await),
                Effect.andThen(wallet.resolvePaymentLink(addr, receipt)),
              ),
          };

          const resolvingA = yield* Effect.forkChild(
            makeWalletEffects(
              heldPort,
              store,
              devicePasskeys,
            ).resolvePaymentLink(),
          );

          yield* started.await;

          yield* store.seed(
            new DeviceWallet({
              ...sender,
              transfer: orderB,
              approvedUntil: Math.floor(Date.now() / 1000) + 180,
              linkReceipt: receiptB,
            }),
          );

          yield* release.open;

          const resolvedA = yield* Fiber.join(resolvingA);

          assertTagged(resolvedA, "LatestPaymentLink");
          expect(resolvedA.balance).toBe(balanceA);

          const storedAfterA = yield* savedWallet(store);

          expect(storedAfterA.transfer?.id).toBe(orderB.id);
          expect(storedAfterA.linkReceipt?.balance).toBe(balanceB);

          const resolvedB = yield* makeWalletEffects(
            wallet,
            store,
            devicePasskeys,
          ).resolvePaymentLink();

          assertTagged(resolvedB, "LatestPaymentLink");
          expect(resolvedB.balance).toBe(balanceB);
          expect(resolvedB.address).toBe(linkB);
        }),
    );
  },
);
