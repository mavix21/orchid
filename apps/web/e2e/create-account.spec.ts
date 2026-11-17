import { expect, test } from "@playwright/test";

const openingChunk = /\/assets\/opening-[\w-]+\.js$/;

test("creates a testnet wallet that survives a reload", async ({ page }) => {
  const requested: Array<string> = [];

  page.on("request", (request) => requested.push(request.url()));

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Tu plata, sin bancos." }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");

  expect(requested.filter((url) => openingChunk.test(url))).toEqual([]);

  const username = `e2e_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await page.getByLabel("Usuario").fill(username);
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(page).toHaveURL("/home", { timeout: 90_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible();
  await expect(page.getByText("$0")).toBeVisible();

  expect(requested.some((url) => openingChunk.test(url))).toBe(true);

  await page.reload();

  await expect(page.getByText(`@${username}`)).toBeVisible({
    timeout: 30_000,
  });
});
