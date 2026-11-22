import { expect, test } from "@playwright/test";

import { submitButton } from "./device";

const instagramOnAndroid =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 Instagram 330.0.0.0.0 Android";

test.use({ userAgent: instagramOnAndroid });

test("an embedded browser is handed off before the account form mounts", async ({
  page,
}) => {
  await page.goto("/create-account#kept");

  await expect(page.getByTestId("embedded-browser")).toBeVisible();
  await expect(submitButton(page)).toBeHidden();
  await expect(page.getByTestId("open-in-browser")).toHaveAttribute(
    "href",
    /^intent:\/\/.+\/create-account#kept#Intent;scheme=https?;end$/,
  );
});
