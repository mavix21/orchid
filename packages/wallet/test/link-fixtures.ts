import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  PaymentLinkRecipient,
  PositiveAmount,
  TransferId,
  TransferOrder,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { signingKey } from "../src/device/signing";
import { type DeviceWallet, memoryKeyStore } from "./device-fixtures";
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

export const advanceSequence = (address: AccountAddress) => {
  const current = world.accounts.get(address) ?? accountState();

  world.accounts.set(address, {
    ...current,
    sequence: (BigInt(current.sequence) + 1n).toString(),
  });
};

export const linkAmount = Schema.decodeSync(PositiveAmount)("10000000");

export const fundLinkFrom = (wallet: WalletPort, sender: DeviceWallet) =>
  Effect.gen(function* () {
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
    advanceSequence(sender.address);

    return { link, balance, transferId: funding.id };
  });

export const fundLink = (username: string) =>
  Effect.gen(function* () {
    const { wallet, sender } = yield* openSender(memoryKeyStore(), username);

    return { wallet, sender, ...(yield* fundLinkFrom(wallet, sender)) };
  });
