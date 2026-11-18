import { expect, test } from "@playwright/test";

const openingChunk = /\/assets\/opening-[\w-]+\.js$/;

test("explains username mistakes while typing", async ({ page }) => {
  await page.goto("/create-account");

  const input = page.getByLabel("Usuario");
  const submit = page.getByRole("button", { name: "Continuar" });

  await input.fill("maria-rojas");
  await expect(
    page.getByText("Solo letras, números y guion bajo."),
  ).toBeVisible();
  await expect(submit).toBeDisabled();

  await input.fill("maria rojas");
  await expect(page.getByText("No puede tener espacios.")).toBeVisible();

  await input.fill("maria_rojas_de_la_paz");
  await expect(page.getByText("Máximo 20 caracteres.")).toBeVisible();
  await expect(page.getByText("21/20")).toBeVisible();
  await expect(submit).toBeDisabled();

  await input.fill("maría");
  await expect(page.getByText("Usa letras sin tildes ni ñ.")).toBeVisible();

  await input.fill("MARIA");
  await expect(input).toHaveValue("maria");
  await expect(page.getByText("5/20")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(submit).toBeEnabled();

  await input.fill("ma");
  await expect(page.getByText("Mínimo 3 caracteres.")).toBeHidden();
  await input.blur();
  await expect(page.getByText("Mínimo 3 caracteres.")).toBeVisible();
});

test("serves the home shell before the wallet loads", async ({ request }) => {
  const html = await (await request.get("/home")).text();

  expect(html).toContain('aria-label="Principal"');
  expect(html).toContain('aria-label="Cargando tu cuenta"');
});

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

  await page.goto("/create-account");

  await expect(page).toHaveURL("/home", { timeout: 60_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible();
});
