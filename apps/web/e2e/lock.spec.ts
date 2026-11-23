import { type Page, expect, test } from "@playwright/test";

import {
  freshUsername,
  openWallet,
  seedWallet,
  unlockButton,
  unlockWallet,
} from "./device";

const resumeWindow = 60_000;

const walletRoutes = [
  ["/home", "open-send"],
  ["/links", "payment-links"],
  ["/send", "open-links"],
] as const;

const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => next,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

const restorePageFromCache = (page: Page) =>
  page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
  });

test("starts every wallet route locked and unlocks only on a verified assertion", async ({
  page,
}) => {
  const device = await seedWallet(page, freshUsername());

  await page.addInitScript(() => sessionStorage.clear());

  for (const [path, content] of walletRoutes) {
    await device.verifyUser(false);
    await page.goto(path);
    await expect(unlockButton(page)).toBeVisible();
    await unlockButton(page).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId(content)).toHaveCount(0);

    await device.verifyUser(true);
    await unlockWallet(page);
    await expect(page.getByTestId(content)).toBeVisible({ timeout: 60_000 });
  }

  await device.verifyUser(false);
  await page.goto("/send/UNHELD");
  await expect(unlockButton(page)).toBeVisible();
});

test("masks on hide, resumes within the window, and locks on a restored page", async ({
  page,
}) => {
  await openWallet(page, freshUsername());

  const content = page.getByTestId("open-send");
  const start = Date.now();

  await page.clock.setFixedTime(start);
  await setVisibility(page, "hidden");
  await expect(unlockButton(page)).toBeVisible();
  await expect(content).toHaveCount(0);

  await page.clock.setFixedTime(start + resumeWindow - 1);
  await setVisibility(page, "visible");
  await expect(content).toBeVisible();

  await restorePageFromCache(page);
  await expect(unlockButton(page)).toBeVisible();
  await expect(content).toHaveCount(0);
});

test("resumes a reloaded tab within the window and locks it after", async ({
  page,
}) => {
  await openWallet(page, freshUsername());

  const content = page.getByTestId("open-send");
  const start = Date.now();

  await page.clock.setFixedTime(start);
  await page.reload();
  await expect(content).toBeVisible();

  await setVisibility(page, "hidden");
  await page.clock.setFixedTime(start + resumeWindow);
  await page.reload();
  await expect(unlockButton(page)).toBeVisible();
  await expect(content).toHaveCount(0);
});
