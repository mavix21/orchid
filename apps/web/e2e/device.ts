import { type Page, expect } from "@playwright/test";

export const addAuthenticator = async (
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

export const freshUsername = () =>
  `e2e_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

export const usernameInput = (page: Page) => page.getByRole("textbox");

export const submitButton = (page: Page) => page.getByTestId("create-submit");

export const topNavLink = (page: Page) => page.getByTestId("top-nav-action");

export const serverFunction = "/_serverFn/";

export const openWallet = async (page: Page, username: string) => {
  const claimed: Array<string> = [];

  page.on("request", (request) => {
    if (request.url().includes(serverFunction))
      claimed.push(...(request.postData()?.match(/G[A-Z2-7]{55}/g) ?? []));
  });

  await addAuthenticator(page, false);
  await page.goto("/create-account");
  await usernameInput(page).fill(username);
  await submitButton(page).click();
  await expect(page).toHaveURL("/home", { timeout: 90_000 });

  const [address] = claimed;

  if (address === undefined) throw new Error("No wallet address was claimed");

  return address;
};
