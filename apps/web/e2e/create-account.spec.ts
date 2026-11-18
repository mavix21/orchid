import { type Page, expect, test } from "@playwright/test";

const openingChunk = /\/assets\/opening-[\w-]+\.js$/;

const addAuthenticator = async (
  page: Page,
  hasPrf: boolean,
  isUserVerified = true,
) => {
  const session = await page.context().newCDPSession(page);

  await session.send("WebAuthn.enable");
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified,
      hasPrf,
      automaticPresenceSimulation: true,
    },
  });
};

const forgetDevice = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("orchid-device");

        request.addEventListener("success", () => resolve());
        request.addEventListener("error", () => reject(request.error));
      }),
  );

const freshUsername = () =>
  `e2e_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

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

test("creates a backed-up testnet wallet and restores it after the device forgets it", async ({
  page,
}) => {
  const requested: Array<string> = [];

  await addAuthenticator(page, true);

  page.on("request", (request) => requested.push(request.url()));

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Tu plata, sin bancos." }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");

  expect(requested.filter((url) => openingChunk.test(url))).toEqual([]);

  const username = freshUsername();

  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await page.getByLabel("Usuario").fill(username);
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(page.getByLabel("Usuario")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Creando tu cuenta…" }),
  ).toBeDisabled();

  const back = page.getByRole("link", { name: "Atrás" });

  await expect(back).toHaveAttribute("aria-disabled", "true");
  await back.click({ force: true });
  await expect(page).toHaveURL("/create-account");

  await expect(page).toHaveURL("/home", { timeout: 90_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible();
  await expect(page.getByText("$0")).toBeVisible();
  await expect(page.getByText("Tu cuenta no tiene respaldo")).toBeHidden();

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
  await page.getByRole("button", { name: "Ya tengo una cuenta" }).click();
  await expect(page).toHaveURL("/restore");
  await page.getByRole("button", { name: "Restaurar con passkey" }).click();

  await expect(page).toHaveURL("/home", { timeout: 60_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Tu cuenta no tiene respaldo")).toBeHidden();

  await page.goto("/restore");

  await expect(page).toHaveURL("/home", { timeout: 30_000 });
});

test("creates a device-only wallet when the passkey has no PRF", async ({
  page,
}) => {
  await addAuthenticator(page, false);

  const username = freshUsername();

  await page.goto("/create-account");
  await page.getByLabel("Usuario").fill(username);
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(page).toHaveURL("/home", { timeout: 90_000 });
  await expect(page.getByText(`@${username}`)).toBeVisible();
  await expect(page.getByText("Tu cuenta no tiene respaldo")).toBeVisible();
  await expect(
    page.getByText(
      "Este navegador no permite respaldar con passkey. Tu llave solo está en este dispositivo.",
    ),
  ).toBeVisible();
});

test("stops creation with a retry when the passkey prompt is cancelled", async ({
  page,
}) => {
  await addAuthenticator(page, true, false);

  await page.goto("/create-account");
  await page.getByLabel("Usuario").fill(freshUsername());
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(
    page.getByText(
      "Necesitas crear una passkey para respaldar tu cuenta. Inténtalo de nuevo.",
    ),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL("/create-account");
  await expect(page.getByRole("button", { name: "Continuar" })).toBeEnabled();
});
