import { type Page, expect, test } from "@playwright/test";
import { readLinkCode } from "@workspace/wallet";
import { fundWithUsdc, usdc } from "@workspace/wallet/testnet";
import * as Option from "effect/Option";

import {
  addAuthenticator,
  countPasskeyPrompts,
  enrollWallet,
  freshUsername,
  storedLinkCiphertexts,
  storedText,
  submitButton,
  usernameInput,
  withoutPrf,
} from "./device";

const stellarSecret = /S[A-Z2-7]{55}/;

const unfundedCode = "Bcru1zp9FViPqN8CJTvQuS2zg";

const sharedLink = (text: string) => {
  const [message = "", url = ""] = text.split("\n\n");
  const link = new URL(url);
  const code = link.hash.slice(1);

  return {
    message,
    link,
    code,
    address: Option.getOrThrow(readLinkCode(code)).link,
  };
};

const reviewLink = async (page: Page) => {
  await page.goto("/send");
  await page.getByTestId(`send-asset-USDC:${usdc.getIssuer()}`).click();
  await page.getByTestId("choose-link").click();
  await page.getByRole("textbox").fill("0.5");
  await page.getByTestId("review-link").click();
  await expect(page.getByTestId("confirm-link")).toBeVisible({
    timeout: 30_000,
  });
};

test("saves a funded link on the device, re-shares it from the links after leaving unshared, recovers it, and never sends its secret or envelope", async ({
  page,
}) => {
  test.setTimeout(600_000);

  const requests: Array<string> = [];
  const shared: Array<string> = [];
  const copied: Array<string> = [];

  page.on("request", (request) => {
    requests.push(`${request.url()}\n${request.postData() ?? ""}`);
  });

  await page.exposeFunction("recordShare", (text: string) => {
    shared.push(text);
  });
  await page.exposeFunction("recordCopy", (url: string) => {
    copied.push(url);
  });
  await page.addInitScript({
    content: `Object.defineProperty(navigator, "share", { configurable: true, value: (data) => window.recordShare(data.text) });
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => window.recordCopy(text) } });`,
  });

  const { address, authenticator } = await enrollWallet(page, freshUsername());

  await fundWithUsdc(address, "1");

  await reviewLink(page);
  await page.getByTestId("confirm-link").click();

  await expect(page.getByTestId("link-created")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByTestId("top-nav-action")).toBeEnabled();

  const envelopes = await storedLinkCiphertexts(page);

  expect(envelopes).toHaveLength(1);

  await page.getByTestId("finish-link").click();
  await page.goto("/send");
  await page.getByTestId("open-links").click();
  await expect(page.getByTestId("reshare-link")).toHaveCount(1, {
    timeout: 30_000,
  });
  expect({ shared, copied }).toEqual({ shared: [], copied: [] });

  await page.getByTestId("reshare-link").click();
  await page.getByTestId("share-link").click();
  await page.getByTestId("copy-link").click();
  await expect(page.getByTestId("link-share-drawer")).toBeVisible();
  await expect.poll(() => copied).toHaveLength(1);

  const [original = ""] = shared;
  const { message, link, code } = sharedLink(original);

  expect(message).not.toBe("");
  expect(link.origin).toBe(new URL(page.url()).origin);
  expect(link.pathname).toBe("/r");
  expect(copied).toEqual([link.href]);
  expect(await page.content()).not.toContain(code);
  expect(await page.content()).not.toMatch(stellarSecret);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("link-share-drawer")).toBeHidden();

  await page.getByTestId("recover-link").click();
  await page.getByTestId("confirm-recover").click();
  await expect(page.getByTestId("link-outcome")).toHaveAttribute(
    "data-outcome",
    "AssetSettled",
    { timeout: 120_000 },
  );
  expect(await storedLinkCiphertexts(page)).toEqual([]);

  const sent = requests.join("\n");

  expect(sent).not.toContain(code);
  expect(sent).not.toMatch(stellarSecret);
  expect(sent).not.toContain(envelopes[0]);

  await withoutPrf(page, authenticator);

  const signedBefore = requests.filter((sent) =>
    sent.includes('"signature"'),
  ).length;

  expect(signedBefore).toBeGreaterThan(0);

  await reviewLink(page);
  await page.getByTestId("save-link").click();
  await expect(page.getByTestId("link-review")).toHaveAttribute(
    "data-saved",
    "false",
    { timeout: 30_000 },
  );
  await page.getByTestId("confirm-link").click();

  await expect(page.getByTestId("link-outcome")).toHaveAttribute(
    "data-outcome",
    "PrfOutputMissing",
    { timeout: 60_000 },
  );
  expect(requests.filter((sent) => sent.includes('"signature"')).length).toBe(
    signedBefore,
  );
});

test("receives a link into a wallet created on the link page with two passkey prompts, never storing or sending its secret, and the sender sees it received", async ({
  browser,
  page,
}) => {
  test.setTimeout(600_000);

  const shared: Array<string> = [];

  await page.exposeFunction("recordShare", (text: string) => {
    shared.push(text);
  });
  await page.addInitScript({
    content: `Object.defineProperty(navigator, "share", { configurable: true, value: (data) => window.recordShare(data.text) });`,
  });

  const senderUsername = freshUsername();
  const { address } = await enrollWallet(page, senderUsername);

  await fundWithUsdc(address, "1");
  await reviewLink(page);
  await page.getByTestId("confirm-link").click();
  await expect(page.getByTestId("link-created")).toBeVisible({
    timeout: 120_000,
  });
  await page.getByTestId("share-link").click();
  await expect.poll(() => shared).toHaveLength(1);

  const [original = ""] = shared;
  const { link, code, address: linkAddress } = sharedLink(original);

  const recipient = await browser.newPage();
  const requests: Array<string> = [];

  recipient.on("request", (request) => {
    requests.push(`${request.url()}\n${request.postData() ?? ""}`);
  });

  await addAuthenticator(recipient, true);

  const prompts = await countPasskeyPrompts(recipient);

  await recipient.goto(`/r#${unfundedCode}`);
  await expect(recipient.getByTestId("link-outcome")).toHaveAttribute(
    "data-outcome",
    "PaymentLinkNotFound",
    { timeout: 30_000 },
  );
  await recipient.evaluate((hash) => {
    window.location.hash = hash;
  }, link.hash);
  await recipient.getByTestId("receive-link").click();

  const recipientUsername = freshUsername();

  await usernameInput(recipient).fill(recipientUsername);
  await submitButton(recipient).click();

  const step = recipient.getByTestId("enrollment-step");

  await expect(step).toHaveAttribute("data-stage", "activate", {
    timeout: 30_000,
  });
  await expect(step).toHaveAttribute("data-receive", "true", {
    timeout: 30_000,
  });
  expect(await prompts()).toEqual({ create: 1, get: 0 });

  await recipient.getByTestId("enrollment-continue").click();
  await expect(recipient.getByTestId("link-outcome")).toHaveAttribute(
    "data-outcome",
    "AssetSettled",
    { timeout: 180_000 },
  );
  expect(await prompts()).toEqual({ create: 1, get: 1 });

  await recipient.reload();
  await expect(recipient.getByTestId("link-outcome")).toHaveAttribute(
    "data-outcome",
    "PaymentLinkUsed",
    { timeout: 60_000 },
  );
  await expect(recipient.getByTestId("receive-link")).toHaveCount(0);

  const recipientStorage = `${await storedText(recipient)}\n${await recipient.evaluate(() => JSON.stringify(sessionStorage))}`;

  expect(requests.join("\n")).not.toContain(code);
  expect(requests.join("\n")).not.toMatch(stellarSecret);
  expect(recipientStorage).not.toContain(code);
  expect(recipientStorage).not.toMatch(stellarSecret);

  await page.goto("/links");
  await expect(
    page.locator(
      `[data-testid="received-link"][data-address="${linkAddress}"]`,
    ),
  ).toBeVisible({ timeout: 60_000 });

  await page.goto("/home");

  const linkEntry = page.getByTestId("activity-row").first();

  await expect(linkEntry).toHaveAttribute("data-entry", "SentActivity");
  await expect(linkEntry).toHaveAttribute("data-receipt", "Claimed");
  await expect(linkEntry).toHaveAttribute(
    "data-counterparty",
    recipientUsername,
  );

  await recipient.goto("/home");

  const claimEntry = recipient.getByTestId("activity-row").first();

  await expect(claimEntry).toHaveAttribute("data-entry", "ClaimedLinkActivity");
  await expect(claimEntry).toHaveAttribute("data-counterparty", senderUsername);
});
