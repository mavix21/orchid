import type { Page } from "@playwright/test";

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

export const usernameInput = (page: Page) =>
  page.locator('input[name="username"]');

export const submitButton = (page: Page) =>
  page.locator('button[type="submit"]');

export const topNavLink = (page: Page) => page.locator("header a");
