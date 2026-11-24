import { expect, layer } from "@effect/vitest";
import { Account, Claimant, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type ActivityPage,
  AssetOrder,
  AssetOrderId,
  type BalanceId,
  ClaimBalance,
  type DestinationAddress,
  ExternalLinkOrder,
  ExternalRecipient,
  InvalidAddress,
  MuxedAddress,
  NotOpened,
  PositiveAmount,
  Profile,
  ReceiveLink,
  TransferOrder,
  Username,
  UsernameRecipient,
  type WalletPort,
} from "../src/contract";
import { signingKey } from "../src/device/signing";
import { Wallet } from "../src/server/Wallet.server";
import { memoryKeyStore } from "./device-fixtures";
import {
  advanceSequence,
  fundLink,
  fundLinkFrom,
  linkAmount,
} from "./link-fixtures";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  approve,
  draftTransfer,
  euro,
  euroLine,
  fundHolder,
  fundedWallet,
  holdingsFor,
  openSender,
  orderFor,
  send,
  settleHash,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const assetOrderId = () => Schema.decodeSync(AssetOrderId)(crypto.randomUUID());

const username = (name: string) => Schema.decodeSync(Username)(name);

const activityOf = Effect.fn(function* (
  wallet: WalletPort,
  address: AccountAddress,
) {
  const page = yield* wallet.activity(address);

  assertTagged(page, "ActivityPage");

  return page;
});

const settleSubmitted = (balance?: BalanceId) =>
  Effect.sync(() => {
    settleHash(
      Option.getOrThrow(Option.fromNullishOr(world.submitted.at(-1))).hash,
    );

    if (balance) world.claimables.delete(balance);
  });

const payUsername = Effect.fn(function* (
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

const receiveInto = Effect.fn(function* (
  wallet: WalletPort,
  claimer: Keypair,
  funded: { readonly link: Keypair; readonly balance: BalanceId },
) {
  const order = new AssetOrder({
    id: assetOrderId(),
    wallet: addressOf(claimer),
    action: ReceiveLink.make({
      link: addressOf(funded.link),
      balance: funded.balance,
    }),
  });

  const draft = yield* wallet.manage(order, Option.none());

  assertTagged(draft, "AssetDraft");
  assertTagged(
    yield* wallet.manage(order, approve(draft.request, funded.link)),
    "AssetPending",
  );
  yield* settleSubmitted(funded.balance);
  assertTagged(yield* wallet.manage(order, Option.none()), "AssetSettled");

  return order;
});

const claimBalance = Effect.fn(function* (
  wallet: WalletPort,
  owner: Keypair,
  balance: BalanceId,
) {
  const order = new AssetOrder({
    id: assetOrderId(),
    wallet: addressOf(owner),
    action: ClaimBalance.make({ balance }),
  });

  const draft = yield* wallet.manage(order, Option.none());

  assertTagged(draft, "AssetDraft");
  assertTagged(
    yield* wallet.manage(order, approve(draft.request, owner)),
    "AssetPending",
  );
  yield* settleSubmitted(balance);
  assertTagged(yield* wallet.manage(order, Option.none()), "AssetSettled");
});

const claimExternally = Effect.fn(function* (
  wallet: WalletPort,
  funded: { readonly link: Keypair; readonly balance: BalanceId },
  destination: DestinationAddress,
) {
  world.accounts.set(addressOf(funded.link), accountState());

  const order = new ExternalLinkOrder({
    id: assetOrderId(),
    link: addressOf(funded.link),
    balance: funded.balance,
    destination,
  });

  const draft = yield* wallet.claimPaymentLink(order, Option.none());

  assertTagged(draft, "ExternalLinkDraft");
  assertTagged(
    yield* wallet.claimPaymentLink(order, approve(draft.request, funded.link)),
    "ExternalLinkPending",
  );
  yield* settleSubmitted(funded.balance);
  assertTagged(
    yield* wallet.claimPaymentLink(order, Option.none()),
    "ExternalLinkSettled",
  );
});

const entryFor = (page: ActivityPage, id: string) => {
  const found = page.entries.find((entry) => entry.id === id);

  if (!found) throw new Error(`Expected an entry for ${id}`);

  return found;
};

const withClaimants = (
  balance: BalanceId,
  holders: ReadonlyArray<AccountAddress>,
) =>
  world.claimables.set(balance, {
    balance,
    asset: euro,
    amount: Schema.decodeSync(PositiveAmount)("10000000"),
    sponsored: true,
    claimants: holders.map(
      (holder) => new Claimant(holder, Claimant.predicateUnconditional()),
    ),
  });

const payWithoutTrustline = Effect.fn(function* (
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
  const balance = Option.getOrThrow(Option.fromNullishOr(settled.claimable));

  return { order, balance };
});

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "lists a payment once for its sender and once for its recipient and never another wallet's activity, without reading the chain",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const alice = yield* fundedWallet("alice");
          const bruno = yield* fundedWallet("bruno");
          const carla = yield* fundedWallet("carla");
          const diana = yield* fundedWallet("diana");

          yield* fundedWallet("diego");

          const { order } = yield* payUsername(alice, "bruno");

          yield* payUsername(carla, "diego");
          yield* receiveInto(wallet, diana, yield* fundLink("strangerfunder"));

          world.ledgerDown = true;
          world.claimablesDown = true;

          const sent = yield* activityOf(wallet, addressOf(alice));
          const received = yield* activityOf(wallet, addressOf(bruno));

          expect(sent.entries.map((entry) => entry._tag)).toEqual([
            "SentActivity",
          ]);
          expect(sent.entries.map((entry) => entry.id)).toEqual([order.id]);
          expect(received.entries.map((entry) => entry._tag)).toEqual([
            "ReceivedActivity",
          ]);
          expect(received.entries.map((entry) => entry.id)).toEqual([order.id]);

          const sentEntry = entryFor(sent, order.id);

          assertTagged(sentEntry, "SentActivity");
          assertTagged(sentEntry.receipt, "Settled");
          expect(sentEntry.receipt.recipient).toEqual(
            new Profile({
              username: username("bruno"),
              address: addressOf(bruno),
            }),
          );

          const receivedEntry = entryFor(received, order.id);

          assertTagged(receivedEntry, "ReceivedActivity");
          expect(receivedEntry.from).toEqual(
            new Profile({
              username: username("alice"),
              address: addressOf(alice),
            }),
          );
        }),
    );

    it.effect(
      "ends each payment link as claimed into a wallet, claimed to an address, recovered or still open, and lists the claim for the wallet that took it",
      () =>
        Effect.gen(function* () {
          const { sender, wallet } = yield* openSender(
            memoryKeyStore(),
            "linkowner",
          );

          const intoWallet = yield* fundLinkFrom(wallet, sender);
          const toAddress = yield* fundLinkFrom(wallet, sender);
          const recovered = yield* fundLinkFrom(wallet, sender);
          const open = yield* fundLinkFrom(wallet, sender);
          const toMuxed = yield* fundLinkFrom(wallet, sender);
          const claimer = yield* fundedWallet("linkclaimer");
          const external = Keypair.random();

          fundHolder(external);

          const claim = yield* receiveInto(wallet, claimer, intoWallet);

          yield* claimExternally(wallet, toAddress, addressOf(external));
          yield* claimExternally(
            wallet,
            toMuxed,
            Schema.decodeSync(MuxedAddress)(
              new MuxedAccount(
                new Account(addressOf(claimer), "0"),
                "42",
              ).accountId(),
            ),
          );
          yield* claimBalance(
            wallet,
            signingKey(sender.phrase),
            recovered.balance,
          );

          const listed = yield* activityOf(wallet, sender.address);

          expect(listed.entries).toHaveLength(5);

          const receiptOf = (id: string) => {
            const entry = entryFor(listed, id);

            assertTagged(entry, "SentActivity");

            return entry.receipt;
          };

          const claimedInto = receiptOf(intoWallet.transferId);

          assertTagged(claimedInto, "Claimed");
          expect(claimedInto.by).toEqual(
            new Profile({
              username: username("linkclaimer"),
              address: addressOf(claimer),
            }),
          );

          const claimedTo = receiptOf(toAddress.transferId);

          assertTagged(claimedTo, "Claimed");
          expect(claimedTo.by).toEqual(
            new ExternalRecipient({ address: addressOf(external) }),
          );
          assertTagged(receiptOf(recovered.transferId), "Refunded");
          assertTagged(receiptOf(open.transferId), "Reserved");

          const claimed = yield* activityOf(wallet, addressOf(claimer));
          const claimEntry = entryFor(claimed, claim.id);

          assertTagged(claimEntry, "ClaimedLinkActivity");
          expect(claimed.entries.map((entry) => entry._tag)).toEqual([
            "ClaimedLinkActivity",
            "ClaimedLinkActivity",
          ]);
          expect(claimEntry.from.username).toBe(username("linkowner"));
          expect(claimEntry.amount).toBe(linkAmount);
        }),
    );

    it.effect(
      "follows a payment that needs acceptance from waiting to received for its recipient and to returned for a payment its sender took back",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const sender = yield* fundedWallet("acceptsender");
          const recipient = yield* fundedWallet("acceptrecipient");

          const accepted = yield* payWithoutTrustline(
            sender,
            "acceptrecipient",
          );

          withClaimants(accepted.balance, [
            addressOf(recipient),
            addressOf(sender),
          ]);

          const waiting = yield* activityOf(wallet, addressOf(recipient));

          assertTagged(
            entryFor(waiting, accepted.order.id),
            "AwaitingAcceptanceActivity",
          );

          const reserved = entryFor(
            yield* activityOf(wallet, addressOf(sender)),
            accepted.order.id,
          );

          assertTagged(reserved, "SentActivity");
          assertTagged(reserved.receipt, "Reserved");

          yield* claimBalance(wallet, recipient, accepted.balance);

          const taken = yield* payWithoutTrustline(sender, "acceptrecipient");

          withClaimants(taken.balance, [
            addressOf(recipient),
            addressOf(sender),
          ]);
          yield* claimBalance(wallet, sender, taken.balance);

          const asRecipient = yield* activityOf(wallet, addressOf(recipient));
          const asSender = yield* activityOf(wallet, addressOf(sender));

          const acceptedEntry = entryFor(asRecipient, accepted.order.id);

          assertTagged(acceptedEntry, "ReceivedActivity");
          expect(acceptedEntry.closedAt).toBeDefined();
          assertTagged(
            entryFor(asRecipient, taken.order.id),
            "TakenBackActivity",
          );

          const acceptedSent = entryFor(asSender, accepted.order.id);

          assertTagged(acceptedSent, "SentActivity");
          assertTagged(acceptedSent.receipt, "Claimed");
          expect(acceptedSent.receipt.by).toEqual(
            new Profile({
              username: username("acceptrecipient"),
              address: addressOf(recipient),
            }),
          );

          const takenSent = entryFor(asSender, taken.order.id);

          assertTagged(takenSent, "SentActivity");
          assertTagged(takenSent.receipt, "Refunded");
        }),
    );

    it.effect(
      "pages through entries that share a millisecond without repeating or skipping one",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const alice = yield* fundedWallet("pager");

          yield* fundedWallet("pagerpeer");
          yield* payUsername(alice, "pagerpeer");

          const copies = yield* Database.use((db) =>
            db.execute(sql`
              insert into transfers (id, sender, recipient, destination, "order", "resolvedRecipient", amount, network, "testnetEpoch", status, envelope, hash, "expiresAt", "concludedAt", "createdAt")
              select copy.id, t.sender, t.recipient, t.destination, replace(t."order", t.id::text, copy.id::text), t."resolvedRecipient", t.amount, t.network, t."testnetEpoch", t.status, t.envelope, t.hash, t."expiresAt", t."concludedAt", t."createdAt" + copy.step * interval '10 microseconds'
              from transfers t
              cross join lateral (select gen_random_uuid() as id, step from generate_series(1, 21) as step) copy
              returning id, "createdAt"::text as at
            `),
          );

          const expected = [...copies.rows]
            .sort((left, right) =>
              String(right.at).localeCompare(String(left.at)),
            )
            .map((copy) => String(copy.id));

          const first = yield* activityOf(wallet, addressOf(alice));

          expect(first.entries).toHaveLength(20);
          expect(first.next).toBeDefined();

          const second = yield* wallet.activity(addressOf(alice), first.next);

          assertTagged(second, "ActivityPage");
          expect(second.next).toBeUndefined();
          expect(
            [...first.entries, ...second.entries]
              .slice(0, 21)
              .map((entry) => entry.id),
          ).toEqual(expected);
          expect(second.entries).toHaveLength(2);
        }),
    );

    it.effect.each([
      {
        name: "an unopened wallet",
        address: () => addressOf(Keypair.random()),
        expected: () => new NotOpened(),
      },
      {
        name: "an address that is not valid",
        address: () => Schema.decodeSync(AccountAddress)(`G${"A".repeat(55)}`),
        expected: (address: AccountAddress) => new InvalidAddress({ address }),
      },
    ])("answers $name without a page", ({ address, expected }) =>
      Effect.gen(function* () {
        const wallet = yield* Wallet;
        const subject = address();

        expect(yield* wallet.activity(subject)).toEqual(expected(subject));
      }),
    );
  },
);
