import {
  Amount,
  Asset,
  AssetId,
  Balance,
  type Holding,
  LinkRecipient,
  PaymentMemo,
  Profile,
  TransferIntent,
  UnclaimedFundsId,
  baseAsset,
  parseAmount,
  precisionOf,
} from "@workspace/wallet";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import { RecipientView, recipientOf } from "./agent-read-tools.server";
import { Refusal, assessmentRefusalOf, refused } from "./agent-refusal.server";
import {
  RiskFlag,
  amountRisks,
  memoRisks,
  paidCounterpartsOf,
  recipientRisks,
} from "./agent-risks.server";
import { decimalOf } from "./agent-views.server";
import { SessionWallet } from "./session-wallet.server";
import { UserInputs } from "./user-inputs.server";

export const DecimalAmount = Schema.String.check(
  Schema.isPattern(/^[0-9]+(\.[0-9]{1,7})?$/u),
).annotate({ description: "A decimal amount such as 5 or 12.50" });

const AssetParameter = AssetId.annotate({
  description: "The asset id from wallet_overview or choose_asset",
});

export const TransferProposal = Schema.Struct({
  recipient: RecipientView,
  asset: Asset,
  amount: Schema.String,
  memo: Schema.optional(PaymentMemo),
  risks: Schema.Array(RiskFlag),
});

export const PaymentLinkProposal = Schema.Struct({
  asset: Asset,
  amount: Schema.String,
  risks: Schema.Array(RiskFlag),
});

export const TakeBackProposal = Schema.Struct({
  link: UnclaimedFundsId,
  asset: Asset,
  amount: Schema.String,
  createdAt: Schema.String,
});

export const ProposeTransfer = Tool.make("propose_transfer", {
  description:
    "Prepare a payment to an @username or an address for the user to review on their device. It moves no money. Pass a memo only when the user typed it in ask_value.",
  parameters: Schema.Struct({
    recipient: Schema.String,
    asset: AssetParameter,
    amount: DecimalAmount,
    memo: Schema.optional(Schema.String),
  }),
  success: TransferProposal,
  failure: Refusal,
  failureMode: "return",
  dependencies: [SessionWallet, UserInputs],
});

export const ProposePaymentLink = Tool.make("propose_payment_link", {
  description:
    "Prepare a payment link for the user to review on their device. Anyone who opens the link can receive the money. It moves no money.",
  parameters: Schema.Struct({ asset: AssetParameter, amount: DecimalAmount }),
  success: PaymentLinkProposal,
  failure: Refusal,
  failureMode: "return",
  dependencies: [SessionWallet],
});

export const ProposeTakeBack = Tool.make("propose_take_back", {
  description:
    "Prepare taking back one of the user's open payment links. Use a link id from payment_links. It moves no money.",
  parameters: Schema.Struct({ link: UnclaimedFundsId }),
  success: TakeBackProposal,
  failure: Refusal,
  failureMode: "return",
  dependencies: [SessionWallet],
});

const unavailable = Effect.mapError(() => refused("wallet_unavailable"));

const holding = Effect.gen(function* () {
  const wallet = yield* SessionWallet;
  const overview = yield* wallet.overview.pipe(unavailable);

  return yield* Match.value(overview).pipe(
    Match.tag("Holding", (held) => Effect.succeed(held)),
    Match.orElse(() => Effect.fail(refused("wallet_not_ready"))),
  );
});

const heldAsset = (held: Holding, id: AssetId) => {
  const balance = held.balances.find((candidate) => candidate.asset.id === id);

  if (balance !== undefined) return Effect.succeed(balance);

  return id === baseAsset.id
    ? Effect.succeed(
        new Balance({
          asset: baseAsset,
          amount: Schema.decodeSync(Amount)("0"),
        }),
      )
    : Effect.fail(refused("asset_not_held"));
};

const unitsOf = (asset: Asset, amount: string) =>
  Option.match(parseAmount(amount, precisionOf(asset)), {
    onNone: () => Effect.fail(refused("amount_invalid")),
    onSome: Effect.succeed,
  });

const memoOf = (text: string) =>
  Schema.decodeOption(PaymentMemo)({ type: "text", value: text });

const typedMemo = Effect.fn("AgentTools.typedMemo")(function* (
  memo: string | undefined,
) {
  if (memo === undefined) return Option.none<PaymentMemo>();

  const inputs = yield* UserInputs;

  if (!inputs.answers.includes(memo))
    return yield* refused("memo_not_from_user");

  return yield* Option.match(memoOf(memo), {
    onNone: () => Effect.fail(refused("memo_not_allowed")),
    onSome: (value) => Effect.succeed(Option.some(value)),
  });
});

export const proposeTransfer = Effect.fn("AgentTools.proposeTransfer")(
  function* (params: typeof ProposeTransfer.parametersSchema.Type) {
    const wallet = yield* SessionWallet;
    const held = yield* holding;
    const balance = yield* heldAsset(held, params.asset);
    const amount = yield* unitsOf(balance.asset, params.amount);
    const to = recipientOf(params.recipient);

    if (Option.isNone(to)) return yield* refused("invalid_address");

    const memo = yield* typedMemo(params.memo);

    const step = yield* wallet
      .assess(
        new TransferIntent({
          to: to.value,
          asset: balance.asset,
          amount,
          memo: Option.getOrUndefined(memo),
        }),
      )
      .pipe(unavailable);

    const assessed = yield* Match.value(step).pipe(
      Match.tag("TransferAssessment", (found) => Effect.succeed(found)),
      Match.orElse((refusal) => Effect.fail(assessmentRefusalOf(refusal))),
    );

    const found = assessed.recipient;

    if (found instanceof LinkRecipient)
      return yield* refused("invalid_address");

    const activity = yield* wallet.activity().pipe(unavailable);

    const paid = paidCounterpartsOf(
      Match.value(activity).pipe(
        Match.tag("ActivityPage", (page) => page.entries),
        Match.orElse(() => []),
      ),
    );

    return TransferProposal.make({
      recipient:
        found instanceof Profile
          ? RecipientView.members[0].make({
              username: found.username,
              address: found.address,
            })
          : RecipientView.members[1].make({
              address: found.address,
              ...Option.match(assessed.exchange, {
                onNone: () => ({}),
                onSome: (exchange) => ({ exchange }),
              }),
              memoRequired: assessed.memoRequired,
            }),
      asset: balance.asset,
      amount: decimalOf(balance.asset, amount),
      ...Option.match(memo, {
        onNone: () => ({}),
        onSome: (typed) => ({ memo: typed }),
      }),
      risks: [
        ...recipientRisks(found, paid),
        ...memoRisks(assessed.memoRequired),
        ...amountRisks(amount, balance.amount),
      ],
    });
  },
);

export const proposePaymentLink = Effect.fn("AgentTools.proposePaymentLink")(
  function* (params: typeof ProposePaymentLink.parametersSchema.Type) {
    const held = yield* holding;
    const balance = yield* heldAsset(held, params.asset);
    const amount = yield* unitsOf(balance.asset, params.amount);

    if (amount > balance.amount) return yield* refused("insufficient_balance");

    return PaymentLinkProposal.make({
      asset: balance.asset,
      amount: decimalOf(balance.asset, amount),
      risks: amountRisks(amount, balance.amount),
    });
  },
);

export const proposeTakeBack = Effect.fn("AgentTools.proposeTakeBack")(
  function* (params: typeof ProposeTakeBack.parametersSchema.Type) {
    const wallet = yield* SessionWallet;
    const step = yield* wallet.paymentLinks.pipe(unavailable);

    const open = Match.value(step).pipe(
      Match.tag("OpenPaymentLinks", (links) => links.links),
      Match.orElse(() => []),
    );

    const link = open.find(
      (candidate) => candidate.unclaimedFunds === params.link,
    );

    if (link === undefined) return yield* refused("link_not_found");

    return TakeBackProposal.make({
      link: link.unclaimedFunds,
      asset: link.asset,
      amount: decimalOf(link.asset, link.amount),
      createdAt: DateTime.formatIso(link.createdAt),
    });
  },
);
