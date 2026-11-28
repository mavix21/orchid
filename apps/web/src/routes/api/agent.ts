import { createFileRoute } from "@tanstack/react-router";

import { answerAgent } from "@/agent/claude-agent.server";

export const Route = createFileRoute("/api/agent")({
  server: { handlers: { POST: ({ request }) => answerAgent(request) } },
});
