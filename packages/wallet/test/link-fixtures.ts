import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  PaymentLinkRecipient,
  PositiveAmount,
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
  holdingsFor,
  openSender,
  settleOnSubmit,
  world,
} from "./wallet-harness";

export const linkAmount = Schema.decodeSync(PositiveAmount)("10000000");

export const fundLink = (username: string) =>
  Effect.gen(function* () {
    const { wallet, sender } = yield* openSender(memoryKeyStore(), username);

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

    const balance = Option.getOrThrow(Option.fromNullishOr(funded.claimable));

    world.accounts.set(addressOf(feePayer), accountState());

    return { wallet, sender, link, balance };
  });
