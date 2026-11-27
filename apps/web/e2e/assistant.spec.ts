import { expect, test } from "@playwright/test";
import { fundWithUsdc, usdc } from "@workspace/wallet/testnet";
import type { UIMessageChunk } from "ai";

import { enrollWallet, freshUsername } from "./device";

const agentEndpoint = "**/api/agent";

const proposedLink = {
  asset: { id: `USDC:${usdc.getIssuer()}`, code: usdc.getCode() },
  amount: "0.5",
  risks: [],
};

const proposal: ReadonlyArray<UIMessageChunk> = [
  { type: "start" },
  { type: "start-step" },
  {
    type: "tool-input-available",
    toolCallId: "link-1",
    toolName: "propose_payment_link",
    input: { asset: proposedLink.asset.id, amount: proposedLink.amount },
  },
  {
    type: "tool-output-available",
    toolCallId: "link-1",
    output: proposedLink,
  },
  { type: "finish-step" },
  { type: "finish" },
];

const eventStream = (chunks: ReadonlyArray<UIMessageChunk>) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

test("opens the link review from an assistant proposal and creates the link with the passkey", async ({
  page,
}) => {
  test.setTimeout(600_000);

  const asked: Array<string> = [];

  await page.route(agentEndpoint, (route) => {
    asked.push(route.request().postData() ?? "");

    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
      },
      body: eventStream(proposal),
    });
  });

  const { address } = await enrollWallet(page, freshUsername());

  await fundWithUsdc(address, "1");

  await page.goto("/assistant");
  await page.getByRole("textbox").fill("link");
  await page.getByRole("textbox").press("Enter");
  await page.getByTestId("agent-save-link").click();
  await page.getByTestId("agent-review").click();

  await expect(page.getByTestId("link-review")).toHaveAttribute(
    "data-amount",
    proposedLink.amount,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("link-review")).toHaveAttribute(
    "data-saved",
    "false",
  );

  await page.getByTestId("confirm-link").click();
  await expect(page.getByTestId("link-created")).toBeVisible({
    timeout: 120_000,
  });

  expect(asked).toHaveLength(1);
  expect(asked.join("\n")).toContain(address);
});
