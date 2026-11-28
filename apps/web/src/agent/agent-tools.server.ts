import { Asset } from "@workspace/wallet";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import {
  ProposePaymentLink,
  ProposeTakeBack,
  ProposeTransfer,
  proposePaymentLink,
  proposeTakeBack,
  proposeTransfer,
} from "./agent-proposals.server";
import {
  CheckRecipient,
  PaymentLinks,
  RecentActivity,
  WalletOverview,
  checkRecipient,
  paymentLinks,
  recentActivity,
  walletOverview,
} from "./agent-read-tools.server";

export const ChooseAsset = Tool.make("choose_asset", {
  description:
    "Ask the user to pick the asset when their request does not name one, or says only dollars. Never assume an asset.",
  parameters: Schema.Struct({ reason: Schema.String }),
  success: Schema.Struct({ asset: Asset }),
  execution: "client",
});

export const ChooseOne = Tool.make("choose_one", {
  description:
    "Ask the user to choose between two to four readings of an ambiguous request, such as two possible recipients.",
  parameters: Schema.Struct({
    question: Schema.String,
    options: Schema.Array(Schema.String).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(4),
    ),
  }),
  success: Schema.Struct({ choice: Schema.String }),
  execution: "client",
});

export const AskValue = Tool.make("ask_value", {
  description:
    "Ask the user to type one missing value, such as an amount or the memo an exchange requires. Never fill it in yourself.",
  parameters: Schema.Struct({
    field: Schema.Literals(["amount", "memo", "recipient"]),
    question: Schema.String,
  }),
  success: Schema.Struct({ value: Schema.String }),
  execution: "client",
});

export const AgentToolkit = Toolkit.make(
  WalletOverview,
  RecentActivity,
  PaymentLinks,
  CheckRecipient,
  ProposeTransfer,
  ProposePaymentLink,
  ProposeTakeBack,
  ChooseAsset,
  ChooseOne,
  AskValue,
);

export const agentToolkitLayer = AgentToolkit.toLayer({
  wallet_overview: () => walletOverview(),
  recent_activity: () => recentActivity(),
  payment_links: () => paymentLinks(),
  check_recipient: checkRecipient,
  propose_transfer: proposeTransfer,
  propose_payment_link: proposePaymentLink,
  propose_take_back: proposeTakeBack,
});
