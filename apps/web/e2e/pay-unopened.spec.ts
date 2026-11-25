import { type Page, expect, test } from "@playwright/test";
import { fundWithUsdc, horizon, usdc } from "@workspace/wallet/testnet";

import {
  enrollOpenedWallet,
  enrollWallet,
  freshUsername,
  walletWithoutSignedOpening,
} from "./device";
import { AccountAddress } from "@workspace/wallet";
import * as Schema from "effect/Schema";

const usdcBalance = async (address: string) => {
  try {
    const account = await horizon.loadAccount(address);

    return (
      account.balances.find(
        (balance) =>
          balance.asset_type === "credit_alphanum4" &&
          balance.asset_code === usdc.getCode() &&
          balance.asset_issuer === usdc.getIssuer(),
      )?.balance ?? "missing"
    );
  } catch {
    return "no account";
  }
};

const pay = async (page: Page, recipient: string, amount: string) => {
  await page.goto("/send");
  await page.getByTestId(`send-asset-USDC:${usdc.getIssuer()}`).click();
  await page.getByTestId("choose-username").click();
  await page.getByRole("textbox").fill(recipient);
  await page.getByTestId("continue-recipient").click();
  await page.getByRole("textbox").fill(amount);
  await page.getByTestId("review-payment").click();
  await page.getByTestId("confirm-payment").click({ timeout: 30_000 });
  await expect(page.getByTestId("send-outcome")).toHaveAttribute(
    "data-outcome",
    "Settled",
    { timeout: 90_000 },
  );
};

test("a payment to an unopened wallet opens its account and arrives without a tap", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);

  const recipientContext = await browser.newContext(test.info().project.use);
  const recipientPage = await recipientContext.newPage();
  const recipient = freshUsername();

  const { address } = await enrollWallet(recipientPage, recipient);
  const recipientAddress = Schema.decodeSync(AccountAddress)(address);

  expect(walletWithoutSignedOpening(recipientAddress)).toBe(true);
  expect(await usdcBalance(address)).toBe("no account");

  const { address: sender } = await enrollOpenedWallet(page, freshUsername());

  await fundWithUsdc(sender, "1");
  await pay(page, recipient, "0.5");

  await recipientPage.goto("/home");

  await expect
    .poll(() => usdcBalance(address), { timeout: 120_000 })
    .toBe("0.5000000");
  await expect(recipientPage.getByTestId("open-send")).toBeVisible({
    timeout: 60_000,
  });
  await expect(recipientPage.getByTestId("waiting-payment")).toBeHidden();

  await recipientContext.close();
});
