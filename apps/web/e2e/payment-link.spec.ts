import { expect, test } from "@playwright/test";
import { fundWithUsdc, usdc } from "@workspace/wallet/testnet";

import { freshUsername, openWallet } from "./device";

const linkPath = /\/l\/G[A-Z2-7]{55}#(S[A-Z2-7]{55})$/;

test("shares a payment link only once it holds the funds, never sends its secret and recovers it", async ({
  page,
}) => {
  test.setTimeout(420_000);

  const requests: Array<string> = [];
  const shared: Array<string> = [];

  page.on("request", (request) => {
    requests.push(`${request.url()}\n${request.postData() ?? ""}`);
  });

  await page.exposeFunction("recordShare", (url: string) => {
    shared.push(url);
  });
  await page.addInitScript({
    content: `Object.defineProperty(navigator, "share", { configurable: true, value: (data) => window.recordShare(data.url) });`,
  });

  const sender = await openWallet(page, freshUsername());

  await fundWithUsdc(sender, "1");

  await page.goto("/send");
  await page.getByTestId(`send-asset-USDC:${usdc.getIssuer()}`).click();
  await page.getByTestId("choose-link").click();
  await page.getByRole("textbox").fill("0.5");
  await page.getByTestId("review-link").click();
  await page.getByTestId("confirm-link").click();

  await expect(page.getByTestId("link-created")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByTestId("top-nav-action")).toBeDisabled();
  expect(shared).toEqual([]);

  await page.getByTestId("share-link").click();
  await expect(page.getByTestId("finish-link")).toBeVisible();

  const [url = ""] = shared;
  const link = new URL(url);
  const [, secret = ""] = linkPath.exec(`${link.pathname}${link.hash}`) ?? [];

  expect(link.origin).toBe(new URL(page.url()).origin);
  expect(secret.length).toBe(56);

  await page.goto("/send");
  await page.getByTestId("open-links").click();
  await expect(page.getByTestId("recover-link")).toHaveCount(1, {
    timeout: 30_000,
  });

  await page.getByTestId("recover-link").click();
  await page.getByTestId("confirm-recover").click();
  await expect(page.getByTestId("link-outcome")).toHaveAttribute(
    "data-outcome",
    "AssetSettled",
    { timeout: 120_000 },
  );

  expect(requests.some((sent) => sent.includes(secret))).toBe(false);
});
