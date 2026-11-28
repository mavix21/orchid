import { createFileRoute } from "@tanstack/react-router";
import * as Match from "effect/Match";

import { AssistantChat } from "@/agent/assistant-chat";
import { Screen, ScreenStatus } from "@/components/screen";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/_wallet/_app/assistant")({
  ssr: false,
  loader: async ({ context }) => ({
    overview: await context.walletClient.overview(),
  }),
  component: AssistantScreen,
});

function AssistantScreen() {
  const { overview } = Route.useLoaderData();

  return Match.value(overview).pipe(
    Match.tag("Holding", (holding) => <AssistantChat holding={holding} />),
    Match.orElse(() => (
      <Screen>
        <ScreenStatus title={m.agent_asset_unavailable()} />
      </Screen>
    )),
  );
}
