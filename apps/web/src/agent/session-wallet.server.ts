import type { AgentWallet } from "@workspace/wallet/server";
import * as Context from "effect/Context";

export class SessionWallet extends Context.Service<
  SessionWallet,
  AgentWallet
>()("@web/agent/SessionWallet") {}
