import { Claimant, Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type ActivityPage,
  AssetOrder,
  AssetOrderId,
  type UnclaimedFundsId,
  ClaimUnclaimedFunds,
  type DestinationAddress,
  ExternalLinkOrder,
  PositiveAmount,
  ReceiveLink,
  TransferOrder,
  Username,
  UsernameRecipient,
  type WalletPort,
} from "../src/contract";
import { advanceSequence } from "./link-fixtures";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  approve,
  draftTransfer,
  euro,
  euroLine,
  holdingsFor,
  orderFor,
  send,
  settleHash,
  world,
} from "./wallet-harness";

export const assetOrderId = () =>
  Schema.decodeSync(AssetOrderId)(crypto.randomUUID());

export const username = (name: string) => Schema.decodeSync(Username)(name);

export const activityOf = Effect.fn(function* (
  wallet: WalletPort,
  address: AccountAddress,
) {
  const page = yield* wallet.activity(address);

  assertTagged(page, "ActivityPage");

  return page;
});

export const settleSubmitted = (unclaimedFunds?: UnclaimedFundsId) =>
  Effect.sync(() => {
    settleHash(
      Option.getOrThrow(Option.fromNullishOr(world.submitted.at(-1))).hash,
    );

    if (unclaimedFunds) world.claimables.delete(unclaimedFunds);
  });

export const payUsername = Effect.fn(function* (
  sender: Keypair,
  recipient: string,
  order = orderFor(
    sender,
    UsernameRecipient.make({ value: username(recipient) }),
  ),
) {
  const draft = yield* draftTransfer(order);

  assertTagged(yield* send(order, approve(draft.request, sender)), "Pending");
  yield* settleSubmitted();

  const settled = yield* send(order);

  assertTagged(settled, "Settled");
  advanceSequence(order.from);

  return { order, settled };
});

export const receiveInto = Effect.fn(function* (
  wallet: WalletPort,
  claimer: Keypair,
  funded: { readonly link: Keypair; readonly unclaimedFunds: UnclaimedFundsId },
) {
  const order = new AssetOrder({
    id: assetOrderId(),
    wallet: addressOf(claimer),
    action: ReceiveLink.make({
      link: addressOf(funded.link),
      unclaimedFunds: funded.unclaimedFunds,
    }),
  });

  const draft = yield* wallet.manage(order, Option.none());

  assertTagged(draft, "AssetDraft");
  assertTagged(
    yield* wallet.manage(order, approve(draft.request, funded.link)),
    "AssetPending",
  );
  yield* settleSubmitted(funded.unclaimedFunds);
  assertTagged(yield* wallet.manage(order, Option.none()), "AssetSettled");

  return order;
});

export const claimBalance = Effect.fn(function* (
  wallet: WalletPort,
  owner: Keypair,
  unclaimedFunds: UnclaimedFundsId,
) {
  const order = new AssetOrder({
    id: assetOrderId(),
    wallet: addressOf(owner),
    action: ClaimUnclaimedFunds.make({ unclaimedFunds }),
  });

  const draft = yield* wallet.manage(order, Option.none());

  assertTagged(draft, "AssetDraft");
  assertTagged(
    yield* wallet.manage(order, approve(draft.request, owner)),
    "AssetPending",
  );
  yield* settleSubmitted(unclaimedFunds);
  assertTagged(yield* wallet.manage(order, Option.none()), "AssetSettled");
});

export const claimExternally = Effect.fn(function* (
  wallet: WalletPort,
  funded: { readonly link: Keypair; readonly unclaimedFunds: UnclaimedFundsId },
  destination: DestinationAddress,
) {
  world.accounts.set(addressOf(funded.link), accountState());

  const order = new ExternalLinkOrder({
    id: assetOrderId(),
    link: addressOf(funded.link),
    unclaimedFunds: funded.unclaimedFunds,
    destination,
  });

  const draft = yield* wallet.claimPaymentLink(order, Option.none());

  assertTagged(draft, "ExternalLinkDraft");
  assertTagged(
    yield* wallet.claimPaymentLink(order, approve(draft.request, funded.link)),
    "ExternalLinkPending",
  );
  yield* settleSubmitted(funded.unclaimedFunds);
  assertTagged(
    yield* wallet.claimPaymentLink(order, Option.none()),
    "ExternalLinkSettled",
  );
});

export const entryFor = (page: ActivityPage, id: string) => {
  const found = page.entries.find((entry) => entry.id === id);

  if (!found) throw new Error(`Expected an entry for ${id}`);

  return found;
};

export const withClaimants = (
  unclaimedFunds: UnclaimedFundsId,
  holders: ReadonlyArray<AccountAddress>,
) =>
  world.claimables.set(unclaimedFunds, {
    unclaimedFunds,
    asset: euro,
    amount: Schema.decodeSync(PositiveAmount)("10000000"),
    sponsored: true,
    claimants: holders.map(
      (holder) => new Claimant(holder, Claimant.predicateUnconditional()),
    ),
  });

export const payWithoutTrustline = Effect.fn(function* (
  sender: Keypair,
  recipient: string,
) {
  const senderAddress = addressOf(sender);

  world.holdings.set(
    senderAddress,
    holdingsFor(senderAddress, { lines: [euroLine("50000000")] }),
  );

  const order = new TransferOrder({
    ...orderFor(sender, UsernameRecipient.make({ value: username(recipient) })),
    asset: euro,
  });

  const { settled } = yield* payUsername(sender, recipient, order);

  const unclaimedFunds = Option.getOrThrow(
    Option.fromNullishOr(settled.unclaimedFunds),
  );

  return { order, unclaimedFunds };
});
