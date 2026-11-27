import { useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { type Holding, baseAsset } from "@workspace/wallet";

import { Screen } from "@/components/screen";
import { m } from "@/paraglide/messages";
import type { AgentMessage, AgentPart, DroppedProposal } from "./agent-message";
import { AgentToolPart } from "./agent-parts";
import { conversationOf } from "./assistant-conversation";

const pickableAssetsOf = (holding: Holding) => {
  const held = holding.balances.map((balance) => balance.asset);

  return held.some((asset) => asset.id === baseAsset.id)
    ? held
    : [baseAsset, ...held];
};

const droppedText: Readonly<Record<DroppedProposal, () => string>> = {
  cancelled: m.agent_proposal_cancelled,
  changing: m.agent_proposal_changing,
};

const droppedOf = (message: AgentMessage, part: AgentPart) =>
  "toolCallId" in part ? message.metadata?.dropped[part.toolCallId] : undefined;

function ToolPart({
  dropped,
  children,
}: {
  dropped: DroppedProposal | undefined;
  children: React.ReactNode;
}) {
  return dropped === undefined ? (
    children
  ) : (
    <p className="self-start text-body text-muted-foreground">
      {droppedText[dropped]()}
    </p>
  );
}

export function AssistantChat({ holding }: { holding: Holding }) {
  const [draft, setDraft] = useState("");

  const request = useRef<HTMLInputElement>(null);

  const { messages, sendMessage, setMessages, addToolOutput, status, error } =
    useChat<AgentMessage>({ chat: conversationOf(holding.profile.address) });

  const drop = (toolCallId: string, reason: DroppedProposal) =>
    setMessages((current) =>
      current.map((message) =>
        message.parts.some(
          (part) => "toolCallId" in part && part.toolCallId === toolCallId,
        )
          ? {
              ...message,
              metadata: {
                dropped: {
                  ...message.metadata?.dropped,
                  [toolCallId]: reason,
                },
              },
            }
          : message,
      ),
    );

  const assets = pickableAssetsOf(holding);

  const send = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (draft.trim() === "") return;

    void sendMessage({ text: draft });
    setDraft("");
  };

  return (
    <Screen>
      <main className="flex flex-1 flex-col gap-3 px-5 py-6">
        <h1 className="font-display text-h2 text-balance">{m.agent_title()}</h1>
        <p className="text-body text-muted-foreground">{m.agent_intro()}</p>
        {messages.map((message) => (
          <div key={message.id} className="flex flex-col gap-2">
            {message.parts.map((part, index) =>
              part.type === "text" ? (
                <p
                  key={`${message.id}-${index}`}
                  className={
                    message.role === "user"
                      ? "self-end rounded-lg bg-secondary px-3 py-2 wrap-anywhere"
                      : "self-start wrap-anywhere"
                  }
                >
                  {part.text}
                </p>
              ) : (
                <ToolPart
                  key={`${message.id}-${index}`}
                  dropped={droppedOf(message, part)}
                >
                  <AgentToolPart
                    part={part}
                    assets={assets}
                    answer={addToolOutput}
                    onCancel={(toolCallId) => drop(toolCallId, "cancelled")}
                    onChange={(toolCallId) => {
                      drop(toolCallId, "changing");
                      request.current?.focus();
                    }}
                  />
                </ToolPart>
              ),
            )}
          </div>
        ))}
        {error === undefined ? null : (
          <p role="alert">{m.agent_unavailable()}</p>
        )}
      </main>
      <form className="flex gap-2 px-5 pb-30 md:pb-16" onSubmit={send}>
        <Input
          ref={request}
          value={draft}
          placeholder={m.agent_placeholder()}
          aria-label={m.agent_placeholder()}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={status !== "ready"}>
          {m.agent_send()}
        </Button>
      </form>
    </Screen>
  );
}
