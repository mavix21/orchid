import type { UIMessageChunk } from "ai";
import * as Match from "effect/Match";
import * as Stream from "effect/Stream";
import type * as Response from "effect/ai/Response";

const unavailable = "The assistant is unavailable right now.";

const declined = "The assistant declined this request.";

const chunksOf = (part: Response.AnyPart): ReadonlyArray<UIMessageChunk> =>
  Match.value(part).pipe(
    Match.withReturnType<ReadonlyArray<UIMessageChunk>>(),
    Match.discriminatorsExhaustive("type")({
      "text-start": ({ id }) => [{ type: "text-start", id }],
      "text-delta": ({ id, delta }) => [{ type: "text-delta", id, delta }],
      "text-end": ({ id }) => [{ type: "text-end", id }],
      "tool-call": ({ id, name, params }) => [
        {
          type: "tool-input-available",
          toolCallId: id,
          toolName: name,
          input: params,
        },
      ],
      "tool-result": (result) =>
        result.isFailure
          ? [
              {
                type: "tool-output-error",
                toolCallId: result.id,
                errorText: JSON.stringify(result.encodedResult),
              },
            ]
          : [
              {
                type: "tool-output-available",
                toolCallId: result.id,
                output: result.encodedResult,
              },
            ],
      finish: ({ reason }) =>
        Match.value(reason).pipe(
          Match.withReturnType<ReadonlyArray<UIMessageChunk>>(),
          Match.when("content-filter", () => [
            { type: "error", errorText: declined },
            { type: "finish-step" },
          ]),
          Match.orElse(() => [{ type: "finish-step" }]),
        ),
      error: () => [{ type: "error", errorText: unavailable }],
      text: () => [],
      reasoning: () => [],
      "reasoning-start": () => [],
      "reasoning-delta": () => [],
      "reasoning-end": () => [],
      "tool-params-start": () => [],
      "tool-params-delta": () => [],
      "tool-params-end": () => [],
      "tool-approval-request": () => [],
      file: () => [],
      source: () => [],
      "response-metadata": () => [],
    }),
  );

export const uiChunks = <E, R>(parts: Stream.Stream<Response.AnyPart, E, R>) =>
  parts.pipe(
    Stream.mapAccum(
      () => false,
      (stepOpen, part): readonly [boolean, ReadonlyArray<UIMessageChunk>] => {
        const chunks = chunksOf(part);

        if (chunks.length === 0) return [stepOpen, chunks];

        const opening: ReadonlyArray<UIMessageChunk> = stepOpen
          ? []
          : [{ type: "start-step" }];

        return [part.type !== "finish", [...opening, ...chunks]];
      },
    ),
    Stream.catchCause(() =>
      Stream.make<ReadonlyArray<UIMessageChunk>>({
        type: "error",
        errorText: unavailable,
      }),
    ),
    (chunks) =>
      Stream.concat(
        Stream.make<ReadonlyArray<UIMessageChunk>>({ type: "start" }),
        Stream.concat(chunks, Stream.make({ type: "finish" })),
      ),
  );
