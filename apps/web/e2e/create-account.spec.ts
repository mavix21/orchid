import { type Page, expect, test } from "@playwright/test";

import {
  addAuthenticator,
  freshUsername,
  submitButton,
  topNavLink,
  usernameInput,
} from "./device";

const openingChunk = /\/assets\/opening-[\w-]+\.js$/;

const forgetDevice = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("orchid-device");

        request.addEventListener("success", () => resolve());
        request.addEventListener("error", () => reject(request.error));
      }),
  );

test("redirects on the server by whether the device holds a wallet", async ({
  request,
}) => {
  const withoutWallet = await request.get("/home", { maxRedirects: 0 });

  const withWallet = await request.get("/", {
    maxRedirects: 0,
    headers: { cookie: "orchid-wallet=1" },
  });

  expect(withoutWallet.status()).toBe(307);
  expect(withoutWallet.headers().location).toBe("/");
  expect(withWallet.status()).toBe(307);
  expect(withWallet.headers().location).toBe("/home");
});

test("creates a backed-up testnet wallet and restores it after the device forgets it", async ({
  page,
}) => {
  const requested: Array<string> = [];

  await addAuthenticator(page, true);

  page.on("request", (request) => requested.push(request.url()));

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  expect(requested.filter((url) => openingChunk.test(url))).toEqual([]);

  const username = freshUsername();

  await page.locator('a[href="/create-account"]').click();
  await usernameInput(page).fill(username);
  await submitButton(page).click();

  await expect(usernameInput(page)).toBeDisabled();

  const back = topNavLink(page);

  await expect(back).toHaveAttribute("aria-disabled", "true");
  await back.click({ force: true });
  await expect(page).toHaveURL("/create-account");

  await expect(page).toHaveURL("/home", { timeout: 90_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible();

  expect(requested.some((url) => openingChunk.test(url))).toBe(true);

  await page.reload();

  await expect(page.getByText(`@${username}`)).toBeVisible({
    timeout: 30_000,
  });

  await page.goto("/create-account");

  await expect(page).toHaveURL("/home", { timeout: 60_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible();

  await forgetDevice(page);
  await page.goto("/");
  await page.locator('a[href="/restore"]').click();
  await expect(page).toHaveURL("/restore");
  await page.locator("button").click();

  await expect(page).toHaveURL("/home", { timeout: 60_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible({
    timeout: 30_000,
  });

  await page.goBack();

  await expect(page).toHaveURL("/home", { timeout: 30_000 });

  await page.goto("/restore");

  await expect(page).toHaveURL("/home", { timeout: 30_000 });

  await page.goto("/");

  await expect(page).toHaveURL("/home", { timeout: 30_000 });
});

test("creates a device-only wallet when the passkey has no PRF", async ({
  page,
}) => {
  await addAuthenticator(page, false);

  const username = freshUsername();

  await page.goto("/create-account");
  await usernameInput(page).fill(username);
  await submitButton(page).click();

  await expect(page).toHaveURL("/home", { timeout: 90_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible();
});

test("returns to the loaded home without the skeleton", async ({ page }) => {
  await addAuthenticator(page, false);

  const username = freshUsername();

  await page.goto("/create-account");
  await usernameInput(page).fill(username);
  await submitButton(page).click();

  await expect(page).toHaveURL("/home", { timeout: 90_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible();

  await page.evaluate(() => {
    new MutationObserver(() => {
      if (document.querySelector("main[aria-busy]"))
        document.documentElement.dataset.skeletonShown = "";
    }).observe(document.body, { childList: true, subtree: true });
  });

  await page.locator('a[href="/send"]').click();
  await expect(page).toHaveURL("/send");

  const revalidation = page.waitForRequest((request) =>
    request.url().includes("/_serverFn/"),
  );

  await topNavLink(page).click();

  await expect(page).toHaveURL("/home");
  await expect(page.getByText(`@${username}`)).toBeVisible();
  await revalidation;
  await expect(page.locator("html[data-skeleton-shown]")).toHaveCount(0);
});

test("stops creation with a retry when the passkey prompt is cancelled", async ({
  page,
}) => {
  await addAuthenticator(page, true, false);

  await page.goto("/create-account");
  await usernameInput(page).fill(freshUsername());
  await submitButton(page).click();

  await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL("/create-account");
  await expect(submitButton(page)).toBeEnabled();
});
