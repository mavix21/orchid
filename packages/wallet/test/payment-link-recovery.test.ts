import { expect, layer } from "@effect/vitest";
import { Claimant, Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
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
import { TransferIntent, makeWalletEffects } from "../src/device/client";
import { DeviceWallet } from "../src/device/key-store";
import { sendTransfer } from "../src/device/sending";
import { signingKey } from "../src/device/signing";
import { Transfers } from "../src/server/Transfers.server";
import { memoryKeyStore, savedWallet } from "./device-fixtures";
import { assertTagged } from "./tagged";
import {
  accountState,
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
  settleOnSubmit,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const linkAmount = Schema.decodeSync(PositiveAmount)("10000000");

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "redraft keeps unresolved attempt IDs and a restarted creation resolves from the stored receipt to one balance",
      () =>
        Effect.gen(function* () {
          const store = memoryKeyStore();
          const { wallet, sender } = yield* openSender(store, "receiptowner");
          const linkAddr = addressOf(Keypair.random());

          const order = new TransferOrder({
            ...orderFor(
              Keypair.random(),
              PaymentLinkRecipient.make({ value: linkAddr }),
            ),
            from: sender.address,
          });

          world.accounts.set(
            sender.address,
            accountState({ sequence: "3000" }),
          );

          const firstDraft = yield* wallet.transfer(order, Option.none());

          assertTagged(firstDraft, "TransferDraft");

          const firstBalance = Option.getOrThrow(
            Option.fromNullishOr(firstDraft.claimable),
          );

          world.accounts.set(
            sender.address,
            accountState({ sequence: "3001" }),
          );

          const redrafted = yield* wallet.transfer(order, Option.none());

          assertTagged(redrafted, "TransferDraft");

          const secondBalance = Option.getOrThrow(
            Option.fromNullishOr(redrafted.claimable),
          );

          expect(secondBalance).not.toBe(firstBalance);

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

          expect(
            yield* Effect.flip(
              sendTransfer(interruptedPort, store).send(
                new TransferIntent({
                  to: PaymentLinkRecipient.make({ value: linkAddr }),
                  asset: baseAsset,
                  amount: linkAmount,
                }),
              ),
            ),
          ).toEqual(new Offline());

          const savedAfterCrash = yield* savedWallet(store);

          expect(savedAfterCrash.linkReceipt?.attempts).toHaveLength(1);

          const restartedDevice = makeWalletEffects(
            wallet,
            store,
            devicePasskeys,
          );

          const resolved = yield* restartedDevice.resolvePaymentLink();

          assertTagged(resolved, "ResolvedPaymentLink");
          expect(resolved.address).toBe(linkAddr);
          expect(resolved.balance).toBe(savedAfterCrash.linkReceipt?.balance);

          const competingLink = addressOf(Keypair.random());

          const competingMiss = yield* wallet.resolvePaymentLink(
            sender.address,
            new PaymentLinkReceipt({
              network: "testnet",
              address: competingLink,
              asset: baseAsset,
              amount: linkAmount,
              balance: resolved.balance,
              attempts: [resolved.balance],
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
          const linkAddr = addressOf(Keypair.random());

          const pendingPort: WalletPort = {
            ...wallet,
            transfer: (nextOrder, approval) =>
              Option.isSome(approval)
                ? wallet
                    .transfer(nextOrder, approval)
                    .pipe(Effect.andThen(Effect.fail(new Offline())))
                : wallet.transfer(nextOrder, approval),
          };

          expect(
            yield* Effect.flip(
              sendTransfer(pendingPort, store).send(
                new TransferIntent({
                  to: PaymentLinkRecipient.make({ value: linkAddr }),
                  asset: baseAsset,
                  amount: linkAmount,
                }),
              ),
            ),
          ).toEqual(new Offline());

          const saved = yield* savedWallet(store);

          const receipt = Option.getOrThrow(
            Option.fromNullishOr(saved.linkReceipt),
          );

          const restarted = makeWalletEffects(wallet, store, devicePasskeys);

          assertTagged(yield* restarted.resolvePaymentLink(), "Pending");
          expect((yield* savedWallet(store)).linkReceipt?.balance).toBe(
            receipt.balance,
          );

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

          assertTagged(resolved, "ResolvedPaymentLink");
          expect(resolved.balance).toBe(receipt.balance);
          expect(resolved.address).toBe(linkAddr);

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

          const cancelled = yield* makeWalletEffects(
            cancelSettlingPort,
            store,
            devicePasskeys,
          ).cancelPaymentLink(resolved);

          assertTagged(cancelled, "AssetSettled");
        }),
    );

    it.effect(
      "cancel checks sender receive capacity, marks an absent balance unresolved, and never hides an unsettled link",
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
            yield* client.cancelPaymentLink({ balance, asset: euro }),
          ).toEqual(
            new RecipientCannotReceive({
              address: sender.address,
              reason: "no_capacity",
            }),
          );

          world.claimables.delete(balance);

          expect(
            yield* client.cancelPaymentLink({ balance, asset: euro }),
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
            yield* client.cancelPaymentLink({
              balance: inflightBalance,
              asset: baseAsset,
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

          yield* store
            .write(
              new DeviceWallet({
                ...sender,
                transfer: orderA,
                approvedUntil: Math.floor(Date.now() / 1000) + 120,
                linkReceipt: receiptA,
              }),
            )
            .pipe(Effect.orDie);

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

          yield* store
            .write(
              new DeviceWallet({
                ...sender,
                transfer: orderB,
                approvedUntil: Math.floor(Date.now() / 1000) + 180,
                linkReceipt: receiptB,
              }),
            )
            .pipe(Effect.orDie);

          yield* release.open;

          const resolvedA = yield* Fiber.join(resolvingA);

          assertTagged(resolvedA, "ResolvedPaymentLink");
          expect(resolvedA.balance).toBe(balanceA);

          const storedAfterA = yield* savedWallet(store);

          expect(storedAfterA.transfer?.id).toBe(orderB.id);
          expect(storedAfterA.linkReceipt?.balance).toBe(balanceB);

          const resolvedB = yield* makeWalletEffects(
            wallet,
            store,
            devicePasskeys,
          ).resolvePaymentLink();

          assertTagged(resolvedB, "ResolvedPaymentLink");
          expect(resolvedB.balance).toBe(balanceB);
          expect(resolvedB.address).toBe(linkB);
        }),
    );
  },
);
