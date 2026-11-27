import { type APIRequestContext, expect, test } from "@playwright/test";

import { countPasskeyPrompts, freshUsername, openWallet } from "./device";

const servedPreview = async (request: APIRequestContext, url: string) => {
  const response = await request.get(url);
  const html = await response.text();

  const meta = (key: string) =>
    new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`).exec(
      html,
    )?.[1] ?? "";

  return {
    html,
    title: meta("og:title"),
    description: meta("og:description"),
    robots: meta("robots"),
    image: meta("og:image"),
  };
};

test("a payment request stays public and shows its cancellation", async ({
  page,
  browser,
}) => {
  const shared: Array<string> = [];

  await page.exposeFunction("recordShare", (text: string) => {
    shared.push(text);
  });
  await page.addInitScript({
    content: `Object.defineProperty(navigator, "share", { configurable: true, value: (data) => window.recordShare(data.text) });`,
  });

  const prompts = await countPasskeyPrompts(page);
  const username = freshUsername();
  const address = await openWallet(page, username);

  await page.getByTestId("open-request").click();
  await page.getByTestId("amount-input").fill("20");
  await page.getByTestId("request-note").fill("  Cena del viernes ");
  await page.getByTestId("create-request").click();
  await page.getByTestId("share-link").click();
  await expect.poll(() => shared).toHaveLength(1);

  const [message = ""] = shared;
  const link = new URL(message.split("\n\n").at(-1) ?? "");

  expect(link.pathname).toMatch(/^\/pay\/[1-9A-HJ-NP-Za-km-z]{10}$/u);

  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();

  await publicPage.goto(link.href);

  const request = publicPage.getByTestId("payment-request");

  await expect(request).toHaveAttribute("data-state", "PaymentRequestOpen");
  await expect(request).toHaveAttribute("data-requester", username);
  await expect(publicPage.getByTestId("payment-request-avatar")).toBeVisible();
  await expect(
    publicPage.getByTestId("payment-request-amount"),
  ).toHaveAttribute("data-amount", "20 USDC");
  await expect(publicPage.getByTestId("payment-request-note")).toHaveAttribute(
    "data-note",
    "Cena del viernes",
  );

  const openPreview = await servedPreview(visitor.request, link.href);

  expect(openPreview.title).toContain(username);
  expect(openPreview.title).toContain("20 USDC");
  expect(openPreview.robots).toContain("noindex");
  expect(openPreview.image).toBe(new URL("/og-payment-request.png", link).href);
  expect(openPreview.html).not.toContain(address);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("request-share")).toBeHidden();
  await page.getByTestId("view-links").click();

  const row = page.getByTestId("open-request-row");

  await expect(row).toHaveAttribute(
    "data-request",
    link.pathname.slice("/pay/".length),
  );

  const promptsBeforeResharing = await prompts();

  await page.getByTestId("reshare-request").click();
  await page.getByTestId("share-link").click();
  await expect.poll(() => shared).toEqual([message, message]);
  expect(await prompts()).toEqual(promptsBeforeResharing);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("request-share")).toBeHidden();
  await page.getByTestId("cancel-request").click();
  await expect(row).toHaveCount(0);

  await publicPage.reload();
  await expect(request).toHaveAttribute(
    "data-state",
    "PaymentRequestCancelled",
  );

  const cancelledPreview = await servedPreview(visitor.request, link.href);

  expect(cancelledPreview.title).toContain(username);
  expect(cancelledPreview.title).not.toBe(openPreview.title);
  expect(cancelledPreview.description).not.toBe(openPreview.description);

  await visitor.close();
});
