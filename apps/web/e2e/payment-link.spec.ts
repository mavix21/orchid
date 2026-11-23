import { type Page, expect, test } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { fundWithUsdc, usdc } from "@workspace/wallet/testnet";

import {
  enrollWallet,
  freshUsername,
  storedLinkCiphertexts,
  visit,
  withoutPrf,
} from "./device";

const linkPath = /\/l\/(G[A-Z2-7]{55})#(S[A-Z2-7]{55})$/;

const reviewLink = async (page: Page) => {
  await visit(page, "/send");
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

  await page.exposeFunction("recordShare", (url: string) => {
    shared.push(url);
  });
  await page.exposeFunction("recordCopy", (url: string) => {
    copied.push(url);
  });
  await page.addInitScript({
    content: `Object.defineProperty(navigator, "share", { configurable: true, value: (data) => window.recordShare(data.url) });
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
  await visit(page, "/send");
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
  const link = new URL(original);

  const [, linkAddress = "", secret = ""] =
    linkPath.exec(`${link.pathname}${link.hash}`) ?? [];

  expect(link.origin).toBe(new URL(page.url()).origin);
  expect(copied).toEqual([original]);
  expect(Keypair.fromSecret(secret).publicKey()).toBe(linkAddress);
  expect(await page.content()).not.toContain(secret);

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

  expect(sent).not.toContain(secret);
  expect(sent).not.toContain(envelopes[0]);

  await withoutPrf(page, authenticator);

  const signedBefore = requests.filter((sent) =>
    sent.includes('"signature"'),
  ).length;

  expect(signedBefore).toBeGreaterThan(0);

  await reviewLink(page);
  await page.getByTestId("once-link").click();
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
