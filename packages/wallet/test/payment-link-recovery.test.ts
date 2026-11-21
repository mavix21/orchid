import { expect, layer } from "@effect/vitest";
import {
  Claimant,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  AssetCode,
  BalanceGone,
  BalanceId,
  IssuedAsset,
  Offline,
  PaymentLinkReceipt,
  PaymentLinkReceiptInvalid,
  PaymentLinkRecipient,
  PositiveAmount,
  RecipientCannotReceive,
  TransferOrder,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { TransferIntent, makeWalletEffects } from "../src/device/client";
import { type KeyStore } from "../src/device/key-store";
import { Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { networkPassphrase } from "../src/stellar/network";
import { memoryKeyStore, savedWallet } from "./device-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  amount,
  holdingsFor,
  orderFor,
  passkeyOrigin,
  settleHash,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const linkAmount = Schema.decodeSync(PositiveAmount)("10000000");
const passkeys = new SoftwareAuthenticator(passkeyOrigin).passkeys;

const euro = IssuedAsset.make({
  code: Schema.decodeSync(AssetCode)("EUR"),
  issuer: addressOf(Keypair.random()),
});

const euroLine = (
  bal: string,
  overrides: Partial<{
    readonly capacity: ReturnType<typeof amount>;
    readonly authorized: boolean;
  }> = {},
) => ({
  asset: euro,
  balance: amount(bal),
  spendable: amount(bal),
  capacity: overrides.capacity ?? amount("9223372036854775807"),
  authorized: overrides.authorized ?? true,
  clawbackEnabled: false,
  sponsored: true,
});

const openSender = Effect.fn(function* (store: KeyStore, name: string) {
  const wallet = yield* Wallet;

  yield* makeWalletEffects(wallet, store, passkeys).create(name);

  const sender = yield* savedWallet(store);

  world.accounts.set(sender.address, accountState());

  return { wallet, sender };
});

const settleLinkOnSubmit =
  (wallet: WalletPort, sender: AccountAddress): WalletPort["transfer"] =>
  (order, approval) =>
    wallet.transfer(order, approval).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sealed = world.submitted.at(-1);

          if (Option.isSome(approval) && sealed) {
            settleHash(sealed.hash);

            const parsed = TransactionBuilder.fromXDR(
              sealed.envelope,
              networkPassphrase,
            );

            const inner =
              parsed instanceof FeeBumpTransaction
                ? parsed.innerTransaction
                : parsed;

            const op = inner.operations[1];

            if (
              op?.type === "createClaimableBalance" &&
              Predicate.isTagged(order.to, "PaymentLink")
            ) {
              const balanceId = Schema.decodeSync(BalanceId)(
                inner.getClaimableBalanceId(1),
              );

              world.claimables.set(balanceId, {
                balance: balanceId,
                asset: order.asset,
                amount: order.amount,
                sponsored: true,
                claimants: [
                  new Claimant(
                    order.to.value,
                    Claimant.predicateUnconditional(),
                  ),
                  new Claimant(sender, Claimant.predicateUnconditional()),
                ],
              });
            }
          }
        }),
      ),
    );

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

          const storedRow = Option.getOrThrow(
            yield* Transfers.use((t) => t.find(order.id)),
          );

          assertTagged(storedRow, "Proposed");
          expect(storedRow.attemptBalances).toEqual([
            firstBalance,
            secondBalance,
          ]);

          const interruptedPort: WalletPort = {
            ...wallet,
            transfer: (nextOrder, approval) =>
              Option.isSome(approval)
                ? settleLinkOnSubmit(wallet, sender.address)(
                    nextOrder,
                    approval,
                  ).pipe(Effect.andThen(Effect.fail(new Offline())))
                : wallet.transfer(nextOrder, approval),
          };

          const firstDevice = makeWalletEffects(
            interruptedPort,
            store,
            passkeys,
          );

          const review = yield* firstDevice.review(
            new TransferIntent({
              to: PaymentLinkRecipient.make({ value: linkAddr }),
              asset: baseAsset,
              amount: linkAmount,
            }),
          );

          assertTagged(review, "PaymentReview");

          const receiptBeforeConfirm = (yield* savedWallet(store)).linkReceipt;

          expect(receiptBeforeConfirm?.attempts).toHaveLength(1);

          world.accounts.set(
            sender.address,
            accountState({ sequence: "3002" }),
          );

          expect(yield* firstDevice.confirm(review)).toEqual(new Offline());

          const savedAfterCrash = yield* savedWallet(store);

          expect(savedAfterCrash.linkReceipt?.attempts).toHaveLength(2);

          const restartedDevice = makeWalletEffects(wallet, store, passkeys);
          const resolved = yield* restartedDevice.resolvePaymentLink();

          assertTagged(resolved, "ResolvedPaymentLink");
          expect(resolved.address).toBe(linkAddr);
          expect(resolved.balance).toBe(savedAfterCrash.linkReceipt?.balance);

          const wrongNetwork = yield* wallet.resolvePaymentLink(
            sender.address,
            new PaymentLinkReceipt({
              network: "public",
              balance: resolved.balance,
              attempts: [resolved.balance],
            }),
          );

          expect(wrongNetwork).toEqual(
            new PaymentLinkReceiptInvalid({ reason: "wrong_network" }),
          );
        }),
    );

    it.effect(
      "cancel checks sender receive capacity and marks disappeared balance without evidence as unresolved",
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

          const client = makeWalletEffects(wallet, store, passkeys);

          expect(yield* client.cancelPaymentLink(balance)).toEqual(
            new RecipientCannotReceive({
              address: sender.address,
              reason: "no_capacity",
            }),
          );

          world.holdings.set(
            sender.address,
            holdingsFor(sender.address, {
              lines: [euroLine("0", { authorized: false })],
            }),
          );

          expect(yield* client.cancelPaymentLink(balance)).toEqual(
            new RecipientCannotReceive({
              address: sender.address,
              reason: "not_authorized",
            }),
          );

          world.claimables.delete(balance);

          expect(yield* client.cancelPaymentLink(balance)).toEqual(
            new BalanceGone({ status: "unresolved" }),
          );
        }),
    );
  },
);
