import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

export const claudeModelLayer = (apiKey: Redacted.Redacted) =>
  AnthropicLanguageModel.layer({
    model: "claude-opus-5-5",
    config: { max_tokens: 4096, output_config: { effort: "medium" } },
  }).pipe(
    Layer.provide(AnthropicClient.layer({ apiKey })),
    Layer.provide(FetchHttpClient.layer),
  );
