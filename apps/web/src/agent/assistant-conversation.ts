import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

import { type AgentMessage, answersComplete } from "./agent-message";

const conversations = new Map<string, Chat<AgentMessage>>();

export const conversationOf = (address: string) => {
  const open = conversations.get(address);

  if (open !== undefined) return open;

  const started = new Chat<AgentMessage>({
    transport: new DefaultChatTransport({
      api: "/api/agent",
      body: { address },
    }),
    sendAutomaticallyWhen: ({ messages }) => answersComplete(messages),
  });

  conversations.set(address, started);

  return started;
};
