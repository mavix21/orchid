import { env } from "cloudflare:workers";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { agentWalletLayer } from "../server/wallet.server";
import { answeringWith } from "./agent.server";
import { claudeModelLayer } from "./claude-model.server";

const claudeLayer = Layer.suspend(() =>
  claudeModelLayer(Redacted.make(env.ANTHROPIC_API_KEY)),
);

export const answerAgent = answeringWith(claudeLayer, agentWalletLayer);
