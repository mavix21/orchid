import type { UIMessageChunk } from "ai";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/ai/LanguageModel";

import { agentTurn } from "../src/agent/agent.server";
import { agentToolkitLayer } from "../src/agent/agent-tools.server";
import { claudeModelLayer } from "../src/agent/claude-model.server";
import { SessionWallet } from "../src/agent/session-wallet.server";
import {
  ChatRequest,
  promptOf,
  userInputsOf,
} from "../src/agent/ui-history.server";
import { uiChunks } from "../src/agent/ui-stream.server";
import { UserInputs } from "../src/agent/user-inputs.server";
import { type GoldCase, goldCases } from "./agent-eval-cases";
import {
  type CallOutcome,
  Output,
  Pending,
  Refused,
  type Scored,
  type TokenCount,
  TracedCall,
  gradeOf,
  isOutput,
  isPending,
  reportOf,
} from "./agent-eval-grading";
import { holder, ledgerWallet } from "./agent-eval-ledger";
import { finished } from "./agent-fixtures";

const Step = Schema.TaggedStruct("Step", {});

const Text = Schema.TaggedStruct("Text", { text: Schema.String });

const Failure = Schema.TaggedStruct("Failure", {});

const Call = Schema.TaggedStruct("Call", {
  id: Schema.String,
  call: TracedCall,
});

const Part = Schema.Union([Step, Text, Failure, Call]);

type Part = typeof Part.Type;

type Turns = ReadonlyArray<ReadonlyArray<Part>>;

const isCall = Predicate.isTagged("Call");

const isFailure = Predicate.isTagged("Failure");

const requestLimit = 6;

const jsonOf = Schema.decodeUnknownSync(Schema.Json);

const partsOf = (
  chunks: ReadonlyArray<UIMessageChunk>,
): ReadonlyArray<Part> => {
  const texts = new Map<string, string>();
  const outcomes = new Map<string, CallOutcome>();

  for (const chunk of chunks) {
    if (chunk.type === "text-delta")
      texts.set(chunk.id, `${texts.get(chunk.id) ?? ""}${chunk.delta}`);

    if (chunk.type === "tool-output-available")
      outcomes.set(
        chunk.toolCallId,
        Output.make({ output: jsonOf(chunk.output) }),
      );

    if (chunk.type === "tool-output-error")
      outcomes.set(chunk.toolCallId, Refused.make({ reason: chunk.errorText }));
  }

  return chunks.flatMap((chunk): ReadonlyArray<Part> => {
    if (chunk.type === "start-step") return [Step.make({})];

    if (chunk.type === "text-start")
      return [Text.make({ text: texts.get(chunk.id) ?? "" })];

    if (chunk.type === "tool-input-available")
      return [
        Call.make({
          id: chunk.toolCallId,
          call: {
            name: chunk.toolName,
            input: jsonOf(chunk.input),
            outcome: outcomes.get(chunk.toolCallId) ?? Pending.make({}),
          },
        }),
      ];

    if (chunk.type === "error") return [Failure.make({})];

    return [];
  });
};

const encodedPartOf = (part: Part): ReadonlyArray<Schema.Json> =>
  Match.value(part).pipe(
    Match.withReturnType<ReadonlyArray<Schema.Json>>(),
    Match.tagsExhaustive({
      Step: () => [{ type: "step-start" }],
      Text: ({ text }) => [{ type: "text", text }],
      Failure: () => [],
      Call: ({ id, call }) => {
        const asked = {
          type: `tool-${call.name}`,
          toolCallId: id,
          input: call.input,
        };

        return [
          Match.value(call.outcome).pipe(
            Match.withReturnType<Schema.Json>(),
            Match.tagsExhaustive({
              Pending: () => ({ ...asked, state: "input-available" }),
              Output: ({ output }) => ({
                ...asked,
                state: "output-available",
                output,
              }),
              Refused: ({ reason }) => ({
                ...asked,
                state: "output-error",
                errorText: reason,
              }),
            }),
          ),
        ];
      },
    }),
  );

const messagesOf = (
  utterance: string,
  turns: Turns,
): ReadonlyArray<Schema.Json> => [
  { role: "user", parts: [{ type: "text", text: utterance }] },
  ...turns.map((parts) => ({
    role: "assistant",
    parts: parts.flatMap(encodedPartOf),
  })),
];

const callsIn = (parts: ReadonlyArray<Part>) =>
  parts.flatMap((part) => (isCall(part) ? [part.call] : []));

const answeredCount = (calls: ReadonlyArray<TracedCall>, name: string) =>
  calls.filter((call) => call.name === name && isOutput(call.outcome)).length;

const Options = Schema.Struct({ options: Schema.Array(Schema.String) });

const answerOf = (
  gold: GoldCase,
  earlier: ReadonlyArray<TracedCall>,
  call: TracedCall,
): Option.Option<Schema.Json> => {
  if (call.name === "choose_asset")
    return Option.fromUndefinedOr(
      gold.ledger.balances
        .map((balance) => balance.asset)
        .find((asset) => asset.code === gold.answers.asset),
    ).pipe(
      Option.map((asset) => ({ asset: { id: asset.id, code: asset.code } })),
    );

  if (call.name === "ask_value")
    return Option.fromUndefinedOr(
      gold.answers.values?.[answeredCount(earlier, "ask_value")],
    ).pipe(Option.map((value) => ({ value })));

  if (call.name === "choose_one")
    return Option.fromUndefinedOr(
      gold.answers.choices?.[answeredCount(earlier, "choose_one")],
    ).pipe(
      Option.flatMap((wanted) =>
        Schema.decodeUnknownOption(Options)(call.input).pipe(
          Option.flatMap(({ options }) =>
            Option.fromUndefinedOr(
              options.find((option) =>
                option.toLowerCase().includes(wanted.toLowerCase()),
              ) ?? options[0],
            ),
          ),
        ),
      ),
      Option.map((choice) => ({ choice })),
    );

  return Option.none();
};

const answered = (
  gold: GoldCase,
  earlier: ReadonlyArray<TracedCall>,
  parts: ReadonlyArray<Part>,
): ReadonlyArray<Part> => {
  const seen = [...earlier];

  return parts.map((part) => {
    if (!isCall(part)) return part;

    const call = Option.match(
      isPending(part.call.outcome)
        ? answerOf(gold, seen, part.call)
        : Option.none(),
      {
        onNone: () => part.call,
        onSome: (output) => ({
          ...part.call,
          outcome: Output.make({ output }),
        }),
      },
    );

    seen.push(call);

    return Call.make({ id: part.id, call });
  });
};

const waiting = (parts: ReadonlyArray<Part>) =>
  callsIn(parts).some((call) => isPending(call.outcome));

const converse = <E>(
  gold: GoldCase,
  model: Layer.Layer<LanguageModel.LanguageModel, E>,
  tokens: Ref.Ref<TokenCount>,
  turns: Turns,
  left: number,
): Effect.Effect<Turns> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(ChatRequest)({
      address: holder.address,
      messages: messagesOf(gold.utterance, turns),
    }).pipe(Effect.orDie);

    const chunks = yield* uiChunks(
      agentTurn(promptOf(request)).pipe(
        Stream.tap((part) =>
          part.type === "finish"
            ? Ref.update(tokens, (count) => ({
                input: count.input + (part.usage.inputTokens.total ?? 0),
                output: count.output + (part.usage.outputTokens.total ?? 0),
              }))
            : Effect.void,
        ),
        Stream.provide(
          Layer.mergeAll(
            model,
            agentToolkitLayer,
            Layer.succeed(SessionWallet, ledgerWallet(gold.ledger)),
            Layer.succeed(UserInputs, { answers: userInputsOf(request) }),
          ),
        ),
      ),
    ).pipe(Stream.runCollect);

    const asked = partsOf(chunks);
    const replied = answered(gold, callsIn(turns.flat()), asked);
    const next = [...turns, replied];

    return waiting(asked) && !waiting(replied) && left > 1
      ? yield* converse(gold, model, tokens, next, left - 1)
      : next;
  });

const evaluate = <E>(
  title: string,
  model: Layer.Layer<LanguageModel.LanguageModel, E>,
  cases: ReadonlyArray<GoldCase>,
) =>
  Effect.gen(function* () {
    const tokens = yield* Ref.make<TokenCount>({ input: 0, output: 0 });

    const scored = yield* Effect.forEach(
      cases,
      (gold) =>
        Effect.map(
          converse(gold, model, tokens, [], requestLimit),
          (turns): Scored => {
            const parts = turns.flat();
            const calls = callsIn(parts);

            return {
              gold,
              calls,
              failed: parts.some(isFailure),
              grade: gradeOf(gold, calls),
            };
          },
        ),
      { concurrency: 4 },
    );

    yield* Console.log(reportOf(title, scored, yield* Ref.get(tokens)));
  });

const silentModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () => Stream.fromIterable([finished("stop")]),
  }),
);

const words = process.argv.slice(2);

const filters = words.filter((word) => word !== "baseline");

const selected = goldCases.filter(
  (gold) =>
    filters.length === 0 ||
    filters.some((filter) => gold.name.includes(filter)),
);

await Effect.runPromise(
  Effect.gen(function* () {
    yield* evaluate("No-op baseline", silentModel, selected);

    if (words.includes("baseline")) return;

    const apiKey = yield* Config.Redacted("ANTHROPIC_API_KEY");

    yield* evaluate("claude-opus-5-5", claudeModelLayer(apiKey), selected);
  }),
);
