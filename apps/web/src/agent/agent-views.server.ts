import {
  type ActivityEntry,
  type Amount,
  Asset,
  type Holding,
  type OpenPaymentLinks,
  type Receipt,
  LinkRecipient,
  Profile,
  type ResolvedRecipient,
  UnclaimedFundsId,
  Username,
  formatAmount,
  precisionOf,
} from "@workspace/wallet";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const decimalOf = (asset: Asset, amount: Amount) =>
  formatAmount(amount, precisionOf(asset));

export const BalanceView = Schema.Struct({
  asset: Asset,
  amount: Schema.String,
});

export const WalletView = Schema.Struct({
  username: Username,
  balances: Schema.Array(BalanceView),
});

export const LinkView = Schema.Struct({
  link: UnclaimedFundsId,
  asset: Asset,
  amount: Schema.String,
  createdAt: Schema.String,
});

export const LinksView = Schema.Struct({
  open: Schema.Array(LinkView),
  receivedCount: Schema.Number,
});

export const Counterpart = Schema.Union([
  Schema.TaggedStruct("Wallet", { username: Username }),
  Schema.TaggedStruct("PaymentLink", {}),
  Schema.TaggedStruct("ExternalAddress", { address: Schema.String }),
]);

export const ActivityView = Schema.Struct({
  direction: Schema.Literals(["sent", "received"]),
  status: Schema.Literals([
    "pending",
    "settled",
    "failed",
    "claimed",
    "taken_back",
    "awaiting_acceptance",
  ]),
  counterpart: Schema.optional(Counterpart),
  asset: Asset,
  amount: Schema.String,
  at: Schema.String,
});

export const ActivityPageView = Schema.Struct({
  entries: Schema.Array(ActivityView),
  more: Schema.Boolean,
});

export const walletViewOf = (holding: Holding) =>
  WalletView.make({
    username: holding.profile.username,
    balances: holding.balances.map((balance) => ({
      asset: balance.asset,
      amount: decimalOf(balance.asset, balance.amount),
    })),
  });

export const linksViewOf = (links: OpenPaymentLinks) =>
  LinksView.make({
    open: links.links.map((link) => ({
      link: link.unclaimedFunds,
      asset: link.asset,
      amount: decimalOf(link.asset, link.amount),
      createdAt: DateTime.formatIso(link.createdAt),
    })),
    receivedCount: links.received.length,
  });

const counterpartOf = (recipient: ResolvedRecipient) =>
  Match.value(recipient).pipe(
    Match.withReturnType<typeof Counterpart.Type>(),
    Match.when(Match.instanceOf(Profile), ({ username }) =>
      Counterpart.members[0].make({ username }),
    ),
    Match.when(Match.instanceOf(LinkRecipient), () =>
      Counterpart.members[1].make({}),
    ),
    Match.orElse(({ address }) => Counterpart.members[2].make({ address })),
  );

const sentStatusOf = (receipt: Receipt) =>
  Match.value(receipt).pipe(
    Match.withReturnType<(typeof ActivityView.Type)["status"]>(),
    Match.tagsExhaustive({
      Pending: () => "pending",
      Reserved: () => "pending",
      Settled: () => "settled",
      Failed: () => "failed",
      Claimed: () => "claimed",
      Refunded: () => "taken_back",
    }),
  );

const sentAtOf = (receipt: Receipt) =>
  Match.value(receipt).pipe(
    Match.tags({
      Settled: ({ settledAt }) => Option.some(settledAt),
      Claimed: ({ closedAt }) => Option.some(closedAt),
      Refunded: ({ closedAt }) => Option.some(closedAt),
    }),
    Match.orElse(() => Option.none()),
  );

export const activityViewOf = (entry: ActivityEntry) =>
  Match.value(entry).pipe(
    Match.withReturnType<typeof ActivityView.Type>(),
    Match.tagsExhaustive({
      SentActivity: ({ receipt, createdAt }) => ({
        direction: "sent",
        status: sentStatusOf(receipt),
        counterpart: counterpartOf(receipt.recipient),
        asset: receipt.asset,
        amount: decimalOf(receipt.asset, receipt.amount),
        at: DateTime.formatIso(
          Option.getOrElse(sentAtOf(receipt), () => createdAt),
        ),
      }),
      ReceivedActivity: ({ from, asset, amount, closedAt, createdAt }) => ({
        direction: "received",
        status: "settled",
        counterpart: Counterpart.members[0].make({ username: from.username }),
        asset,
        amount: decimalOf(asset, amount),
        at: DateTime.formatIso(closedAt ?? createdAt),
      }),
      AwaitingAcceptanceActivity: ({ from, asset, amount, createdAt }) => ({
        direction: "received",
        status: "awaiting_acceptance",
        counterpart: Counterpart.members[0].make({ username: from.username }),
        asset,
        amount: decimalOf(asset, amount),
        at: DateTime.formatIso(createdAt),
      }),
      TakenBackActivity: ({ asset, amount, closedAt }) => ({
        direction: "received",
        status: "taken_back",
        counterpart: Counterpart.members[1].make({}),
        asset,
        amount: decimalOf(asset, amount),
        at: DateTime.formatIso(closedAt),
      }),
      ClaimedLinkActivity: ({ asset, amount, createdAt }) => ({
        direction: "received",
        status: "settled",
        counterpart: Counterpart.members[1].make({}),
        asset,
        amount: decimalOf(asset, amount),
        at: DateTime.formatIso(createdAt),
      }),
      DepositActivity: ({ from, asset, amount, createdAt }) => ({
        direction: "received",
        status: "settled",
        counterpart: Counterpart.members[2].make({ address: from.address }),
        asset,
        amount: decimalOf(asset, amount),
        at: DateTime.formatIso(createdAt),
      }),
    }),
  );
