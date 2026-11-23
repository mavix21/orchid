import { expect, test } from "@playwright/test";
import { AccountAddress } from "@workspace/wallet";
import * as Schema from "effect/Schema";

import {
  addAuthenticator,
  freshUsername,
  markWalletRecovered,
  storedWalletAddress,
  submitButton,
  usernameInput,
} from "./device";

test("authorizes a recovered wallet with one passkey tap and lands on its home", async ({
  page,
}) => {
  await addAuthenticator(page, true);
  await page.goto("/");

  const username = freshUsername();

  await page.getByTestId("start-create").click();
  await usernameInput(page).fill(username);
  await submitButton(page).click();
  await page.getByTestId("enrollment-continue").click();
  await expect(page.getByTestId("open-send")).toBeVisible({ timeout: 120_000 });

  markWalletRecovered(
    Schema.decodeSync(AccountAddress)(await storedWalletAddress(page)),
  );

  await page.goto("/home");

  await expect(page.getByTestId("opening-username")).toBeVisible();
  await expect(page.getByText(`@${username}`)).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();

  const confirm = page.getByTestId("confirm-opening");

  await expect(confirm).toBeVisible();

  await confirm.click();

  await expect(page.getByTestId("open-send")).toBeVisible({ timeout: 120_000 });
});
