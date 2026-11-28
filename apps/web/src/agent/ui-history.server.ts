import { AccountAddress } from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Prompt from "effect/ai/Prompt";
import {
  ProposePaymentLink,
  ProposeTakeBack,
  ProposeTransfer,
} from "./agent-proposals.server";
import {
  CheckRecipient,
  PaymentLinks,
  RecentActivity,
  WalletOverview,
} from "./agent-read-tools.server";
import { AskValue, ChooseAsset, ChooseOne } from "./agent-tools.server";

const historyLimit = 40;

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const StepStart = Schema.Struct({ type: Schema.Literal("step-start") });

const ToolType = Schema.Literals([
  `tool-${WalletOverview.name}`,
  `tool-${RecentActivity.name}`,
  `tool-${PaymentLinks.name}`,
  `tool-${CheckRecipient.name}`,
  `tool-${ProposeTransfer.name}`,
  `tool-${ProposePaymentLink.name}`,
  `tool-${ProposeTakeBack.name}`,
  `tool-${ChooseAsset.name}`,
  `tool-${ChooseOne.name}`,
  `tool-${AskValue.name}`,
]);

const ToolAsked = Schema.Struct({
  type: ToolType,
  toolCallId: Schema.String,
  state: Schema.Literal("input-available"),
  input: Schema.Json,
});

const ToolAnswered = Schema.Struct({
  type: ToolType,
  toolCallId: Schema.String,
  state: Schema.Literal("output-available"),
  input: Schema.Json,
  output: Schema.Json,
});

const ToolErrored = Schema.Struct({
  type: ToolType,
  toolCallId: Schema.String,
  state: Schema.Literal("output-error"),
  input: Schema.Json,
  errorText: Schema.String,
});

const AssistantPart = Schema.Union([
  TextPart,
  StepStart,
  ToolAsked,
  ToolAnswered,
  ToolErrored,
]);

type AssistantPart = typeof AssistantPart.Type;

const UserTurn = Schema.Struct({
  role: Schema.Literal("user"),
  parts: Schema.Array(TextPart),
});

const DroppedProposals = Schema.Record(
  Schema.String,
  Schema.Literals(["cancelled", "changing"]),
);

type DroppedProposals = typeof DroppedProposals.Type;

const AssistantTurn = Schema.Struct({
  role: Schema.Literal("assistant"),
  parts: Schema.Array(AssistantPart),
  metadata: Schema.optional(Schema.Struct({ dropped: DroppedProposals })),
});

type AssistantTurn = typeof AssistantTurn.Type;

export const ChatRequest = Schema.Struct({
  address: AccountAddress,
  messages: Schema.Array(Schema.Union([UserTurn, AssistantTurn])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(historyLimit),
  ),
});

export type ChatRequest = typeof ChatRequest.Type;

const skippedQuestion = "The user did not answer and wrote a new message.";

const droppedResult = {
  cancelled: "The user cancelled this proposal.",
  changing: "The user dropped this proposal to change it.",
};

const toolCallOf = (part: AssistantPart) =>
  part.type === "text" || part.type === "step-start"
    ? []
    : [
        Prompt.toolCallPart({
          id: part.toolCallId,
          name: part.type.slice("tool-".length),
          params: part.input,
          providerExecuted: false,
        }),
      ];

const toolResultOf = (part: AssistantPart, dropped: DroppedProposals) => {
  if (part.type === "text" || part.type === "step-start") return [];

  const name = part.type.slice("tool-".length);
  const reason = dropped[part.toolCallId];

  if (reason !== undefined)
    return [
      Prompt.toolResultPart({
        id: part.toolCallId,
        name,
        isFailure: true,
        result: droppedResult[reason],
        providerExecuted: false,
      }),
    ];

  if (part.state === "input-available")
    return [
      Prompt.toolResultPart({
        id: part.toolCallId,
        name,
        isFailure: true,
        result: skippedQuestion,
        providerExecuted: false,
      }),
    ];

  if (part.state === "output-error")
    return [
      Prompt.toolResultPart({
        id: part.toolCallId,
        name,
        isFailure: true,
        result: part.errorText,
        providerExecuted: false,
      }),
    ];

  return [
    Prompt.toolResultPart({
      id: part.toolCallId,
      name,
      isFailure: false,
      result: part.output,
      providerExecuted: false,
    }),
  ];
};

const stepsOf = (parts: ReadonlyArray<AssistantPart>) => {
  const steps: Array<Array<AssistantPart>> = [[]];

  for (const part of parts) {
    if (part.type === "step-start") steps.push([]);
    else steps.at(-1)?.push(part);
  }

  return steps;
};

const assistantMessagesOf = ({ parts, metadata }: AssistantTurn) =>
  stepsOf(parts).flatMap((step) => {
    const texts = step.flatMap((part) =>
      part.type === "text" ? [Prompt.textPart({ text: part.text })] : [],
    );

    const calls = step.flatMap(toolCallOf);

    const results = step.flatMap((part) =>
      toolResultOf(part, metadata?.dropped ?? {}),
    );

    const content = [...texts, ...calls];

    if (content.length === 0) return [];

    const said = Prompt.assistantMessage({ content });

    return results.length === 0
      ? [said]
      : [said, Prompt.toolMessage({ content: results })];
  });

export const promptOf = (request: ChatRequest) =>
  Prompt.fromMessages(
    request.messages.flatMap((turn): ReadonlyArray<Prompt.Message> =>
      turn.role === "user"
        ? [
            Prompt.userMessage({
              content: turn.parts.map((part) =>
                Prompt.textPart({ text: part.text }),
              ),
            }),
          ]
        : assistantMessagesOf(turn),
    ),
  );

const AskValueAnswered = Schema.Struct({
  type: Schema.Literal(`tool-${AskValue.name}`),
  state: Schema.Literal("output-available"),
  output: Schema.Struct({ value: Schema.String }),
});

export const userInputsOf = (request: ChatRequest) =>
  request.messages.flatMap((turn) =>
    turn.role === "user"
      ? []
      : turn.parts.flatMap((part) =>
          Option.toArray(
            Schema.decodeUnknownOption(AskValueAnswered)(part),
          ).map((answered) => answered.output.value),
        ),
  );
