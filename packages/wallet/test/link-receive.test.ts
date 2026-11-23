import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AssetOrder,
  AssetOrderId,
  BalanceGone,
  PaymentLinkRecipient,
  PaymentLinkUsed,
  PositiveAmount,
  ReceiveLink,
  TransferId,
  TransferOrder,
  baseAsset,
} from "../src/contract";
import { signingKey } from "../src/device/signing";
import { memoryKeyStore } from "./device-fixtures";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  approve,
  euroLine,
  feePayer,
  fundedWallet,
  holdingsFor,
  openSender,
  settleHash,
  settleOnSubmit,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const linkAmount = Schema.decodeSync(PositiveAmount)("10000000");

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "a link receive replayed after its approval pays once, cleans up its link account and shows the sender a received link",
      () =>
        Effect.gen(function* () {
          const { wallet, sender } = yield* openSender(
            memoryKeyStore(),
            "linkfunder",
          );

          world.holdings.set(
            sender.address,
            holdingsFor(sender.address, {
              lines: [{ ...euroLine("500000000"), asset: baseAsset }],
            }),
          );

          const link = Keypair.random();

          const funding = new TransferOrder({
            id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
            from: sender.address,
            to: PaymentLinkRecipient.make({ value: addressOf(link) }),
            asset: baseAsset,
            amount: linkAmount,
          });

          const fundingDraft = yield* wallet.transfer(funding, Option.none());

          assertTagged(fundingDraft, "TransferDraft");
          yield* settleOnSubmit(wallet, sender.address)(
            funding,
            approve(fundingDraft.request, signingKey(sender.phrase)),
          );

          const funded = yield* wallet.transfer(funding, Option.none());

          assertTagged(funded, "Settled");

          const balance = Option.getOrThrow(
            Option.fromNullishOr(funded.claimable),
          );

          const recipient = yield* fundedWallet("linkreceiver");

          world.accounts.set(addressOf(feePayer), accountState());

          const receiveOrder = () =>
            new AssetOrder({
              id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
              wallet: addressOf(recipient),
              action: ReceiveLink.make({ link: addressOf(link), balance }),
            });

          const receive = receiveOrder();
          const drafted = yield* wallet.manage(receive, Option.none());

          assertTagged(drafted, "AssetDraft");

          const approval = approve(drafted.request, link);
          const fundingSubmissions = world.submitted.length;
          const released = yield* wallet.manage(receive, approval);
          const replayed = yield* wallet.manage(receive, approval);

          assertTagged(released, "AssetPending");
          expect(replayed).toEqual(released);

          const receipts = new Set(
            world.submitted
              .slice(fundingSubmissions)
              .map((sealed) => sealed.hash),
          );

          expect(receipts.size).toBe(1);

          for (const hash of receipts) settleHash(hash);

          world.claimables.delete(balance);

          expect((yield* wallet.manage(receive, Option.none()))._tag).toBe(
            "AssetSettled",
          );
          expect(yield* wallet.manage(receiveOrder(), Option.none())).toEqual(
            new BalanceGone({ status: "claimed" }),
          );
          expect(yield* wallet.paymentLink(addressOf(link))).toEqual(
            new PaymentLinkUsed(),
          );
          expect(world.accounts.has(addressOf(link))).toBe(false);

          const listed = yield* wallet.paymentLinks(sender.address);

          assertTagged(listed, "OpenPaymentLinks");
          expect({
            open: listed.links,
            received: listed.received.map((entry) => entry.address),
          }).toEqual({ open: [], received: [addressOf(link)] });
        }),
    );
  },
);
