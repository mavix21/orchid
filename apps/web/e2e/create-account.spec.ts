import { type Page, expect, test } from "@playwright/test";

import {
  addAuthenticator,
  freshUsername,
  openWallet,
  storedWalletRecord,
  submitButton,
  topNavLink,
  usernameInput,
} from "./device";

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

test("enrolls a new wallet only after a fresh user-initiated reopen proof", async ({
  page,
}) => {
  await addAuthenticator(page, true);

  await page.goto("/");

  const username = freshUsername();

  await page.getByTestId("start-create").click();
  await usernameInput(page).fill(username);
  await submitButton(page).click();

  const step = page.getByTestId("enrollment-step");

  await expect(step).toBeVisible({ timeout: 30_000 });
  await expect(step).toHaveAttribute("data-stage", "reopen");
  expect(await storedWalletRecord(page)).toBe(false);

  await page.getByTestId("enrollment-continue").click();

  await expect(page.getByTestId("enrollment-complete")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`@${username}`)).toBeVisible();
  expect(await storedWalletRecord(page)).toBe(true);

  await page.reload();

  await expect(page.getByTestId("enrollment-complete")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`@${username}`)).toBeVisible();

  await forgetDevice(page);
  await page.goto("/");
  await page.getByTestId("start-restore").click();
  await expect(page).toHaveURL("/restore");
  await page.getByTestId("restore-submit").click();
  await page.getByTestId("restore-submit").click();
  await page.getByTestId("restore-submit").click();

  await expect(page.getByTestId("enrollment-complete")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(`@${username}`)).toBeVisible();
  expect(await storedWalletRecord(page)).toBe(true);
});

test("refuses creation when the passkey has no PRF", async ({ page }) => {
  await addAuthenticator(page, false);

  const username = freshUsername();

  await page.goto("/create-account");
  await usernameInput(page).fill(username);
  await submitButton(page).click();

  const step = page.getByTestId("enrollment-step");

  await expect(step).toBeVisible({ timeout: 30_000 });
  await expect(step).toHaveAttribute("data-stage", "prf");
  expect(await storedWalletRecord(page)).toBe(false);

  await page.getByTestId("enrollment-continue").click();

  await expect(page.getByTestId("prf-unsupported")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("enrollment-continue")).toBeHidden();
  await expect(page).toHaveURL("/create-account");
  expect(await storedWalletRecord(page)).toBe(false);
});

test("returns to the loaded home without the skeleton", async ({ page }) => {
  const username = freshUsername();

  await openWallet(page, username);
  await expect(page.getByText(`@${username}`)).toBeVisible();

  await page.evaluate(() => {
    new MutationObserver(() => {
      document.querySelectorAll("main[aria-busy]").forEach(() => {
        document.documentElement.dataset.skeletonShown = "";
      });
    }).observe(document.body, { childList: true, subtree: true });
  });

  await page.getByTestId("open-send").click();
  await expect(page).toHaveURL("/send");

  const revalidation = page.waitForRequest((request) =>
    request.url().includes("/_serverFn/"),
  );

  await topNavLink(page).click();

  await expect(page).toHaveURL("/home");
  await expect(page.getByText(`@${username}`)).toBeVisible();
  await revalidation;
  expect(
    await page.evaluate(() => document.documentElement.dataset.skeletonShown),
  ).toBeUndefined();
});

test("stops creation with a retry when the passkey prompt is cancelled", async ({
  page,
}) => {
  await addAuthenticator(page, true, false);
  await page.route("**/_serverFn/**", (route) =>
    route.request().postData()?.includes('"enrollment"')
      ? route.fulfill({ json: { result: "A".repeat(43) } })
      : route.continue(),
  );

  await page.goto("/create-account");
  await usernameInput(page).fill(freshUsername());
  await submitButton(page).click();

  await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL("/create-account");
  await expect(submitButton(page)).toBeEnabled();
  expect(await storedWalletRecord(page)).toBe(false);
});
