import { expect, test } from "@playwright/test";

import { enrollWallet, freshUsername } from "./device";

test("opens an unopened wallet with one passkey tap before showing its deposit address", async ({
  page,
}) => {
  const { address } = await enrollWallet(page, freshUsername());

  await page.getByTestId("open-receive").click();

  const confirm = page.getByTestId("confirm-opening");
  const shown = page.getByTestId("deposit-address");

  await expect(confirm).toBeVisible({ timeout: 60_000 });
  await expect(shown).toBeHidden();

  await confirm.click();

  await expect(shown).toHaveAttribute("data-address", address, {
    timeout: 120_000,
  });
});
