import type { UIDataTypes, UIMessage } from "ai";

type AssetView = { id: string; code: string };

type RiskFlag =
  | "first_payment"
  | "lookalike_username"
  | "external_address"
  | "memo_required"
  | "muxed_address"
  | "large_share";

type RecipientView =
  | { _tag: "Wallet"; username: string; address: string }
  | {
      _tag: "External";
      address: string;
      exchange?: string;
      memoRequired: boolean;
    };

type AgentTools = {
  choose_asset: { input: { reason: string }; output: { asset: AssetView } };
  choose_one: {
    input: { question: string; options: Array<string> };
    output: { choice: string };
  };
  ask_value: {
    input: { field: "amount" | "memo" | "recipient"; question: string };
    output: { value: string };
  };
  propose_transfer: {
    input: { recipient: string; asset: string; amount: string; memo?: string };
    output: {
      recipient: RecipientView;
      asset: AssetView;
      amount: string;
      memo?: { type: "text" | "id"; value: string };
      risks: Array<RiskFlag>;
    };
  };
  propose_payment_link: {
    input: { asset: string; amount: string };
    output: { asset: AssetView; amount: string; risks: Array<RiskFlag> };
  };
  propose_take_back: {
    input: { link: string };
    output: {
      link: string;
      asset: AssetView;
      amount: string;
      createdAt: string;
    };
  };
};

type DroppedProposal = "cancelled" | "changing";

type AgentMetadata = { dropped: Record<string, DroppedProposal> };

export type AgentMessage = UIMessage<AgentMetadata, UIDataTypes, AgentTools>;

export type AgentPart = AgentMessage["parts"][number];

export type { AssetView, DroppedProposal, RiskFlag };

const clientTools = new Set([
  "tool-choose_asset",
  "tool-choose_one",
  "tool-ask_value",
]);

const lastStepOf = (message: AgentMessage) =>
  message.parts.slice(
    message.parts.map((part) => part.type).lastIndexOf("step-start") + 1,
  );

const answered = (part: AgentPart) =>
  "state" in part &&
  (part.state === "output-available" || part.state === "output-error");

export const answersComplete = (messages: ReadonlyArray<AgentMessage>) => {
  const last = messages.at(-1);

  if (last === undefined || last.role !== "assistant") return false;

  const tools = lastStepOf(last).filter((part) =>
    part.type.startsWith("tool-"),
  );

  return (
    tools.some((part) => clientTools.has(part.type)) && tools.every(answered)
  );
};
