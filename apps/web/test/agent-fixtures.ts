import { Keypair } from "@stellar/stellar-sdk";
import {
  AccountAddress,
  ActivityPage,
  Amount,
  Asset,
  Balance,
  ExternalRecipient,
  Holding,
  OpenPaymentLink,
  OpenPaymentLinks,
  PositiveAmount,
  Profile,
  RecipientCheck,
  TransferAssessment,
  TransferId,
  UnclaimedFundsId,
  Username,
  baseAsset,
} from "@workspace/wallet";
import type { AgentWallet } from "@workspace/wallet/server";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Response from "effect/ai/Response";

import { SessionWallet } from "../src/agent/session-wallet.server";

const addressOf = () =>
  Schema.decodeSync(AccountAddress)(Keypair.random().publicKey());

export const holderAddress = addressOf();

export const ana = new Profile({
  username: Schema.decodeSync(Username)("ana"),
  address: addressOf(),
});

export const exchange = new ExternalRecipient({ address: addressOf() });

export const unheldAsset = Asset.make({
  id: Schema.decodeSync(Asset.fields.id)(`EURC:${addressOf()}`),
  code: Schema.decodeSync(Asset.fields.code)("EURC"),
});

export const openLink = new OpenPaymentLink({
  id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
  unclaimedFunds: Schema.decodeSync(UnclaimedFundsId)(
    `00000000${"ab".repeat(32)}`,
  ),
  address: addressOf(),
  asset: baseAsset,
  amount: Schema.decodeSync(PositiveAmount)("50000000"),
  createdAt: DateTime.makeUnsafe(0),
});

const holding = new Holding({
  profile: new Profile({
    username: Schema.decodeSync(Username)("julio"),
    address: holderAddress,
  }),
  reserveSponsor: Option.none(),
  balances: [
    new Balance({
      asset: baseAsset,
      amount: Schema.decodeSync(Amount)("200000000"),
    }),
  ],
  unclaimedFunds: [],
  latest: Option.none(),
});

const fakeWallet: AgentWallet = {
  overview: Effect.succeed(holding),
  paymentLinks: Effect.succeed(
    new OpenPaymentLinks({ links: [openLink], received: [] }),
  ),
  activity: () => Effect.succeed(new ActivityPage({ entries: [] })),
  assess: (intent) =>
    Effect.succeed(
      Match.value(intent.to).pipe(
        Match.tag(
          "Username",
          () =>
            new TransferAssessment({
              recipient: ana,
              memoRequired: false,
              exchange: Option.none(),
            }),
        ),
        Match.orElse(
          () =>
            new TransferAssessment({
              recipient: exchange,
              memoRequired: true,
              exchange: Option.some("Binance"),
            }),
        ),
      ),
    ),
  checkRecipient: () =>
    Effect.succeed(
      new RecipientCheck({
        recipient: ana,
        memoRequired: false,
        exchange: Option.none(),
      }),
    ),
};

export const sessionWallet = () => Layer.succeed(SessionWallet, fakeWallet);

export const finished = (
  reason: "tool-calls" | "stop" | "content-filter",
): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: {}, outputTokens: {} },
});

export const said = (
  text: string,
): ReadonlyArray<Response.StreamPartEncoded> => [
  { type: "text-start", id: "reply" },
  { type: "text-delta", id: "reply", delta: text },
  { type: "text-end", id: "reply" },
  finished("stop"),
];

export const toolCall = (
  id: string,
  name: string,
  params: Schema.Json,
): ReadonlyArray<Response.StreamPartEncoded> => [
  { type: "tool-call", id, name, params },
  finished("tool-calls"),
];
