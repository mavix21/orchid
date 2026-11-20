import { type Page, expect, test } from "@playwright/test";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  AccountAddress,
  ExternalMemoRequired,
  TransferStep,
} from "@workspace/wallet";
import * as Schema from "effect/Schema";

import {
  addAuthenticator,
  freshUsername,
  submitButton,
  usernameInput,
} from "./device";

const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

const usdc = new Asset(
  "USDC",
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
);

const serverFunction = "/_serverFn/";

const openWallet = async (page: Page, username: string) => {
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

const fundWithUsdc = async (address: string, amount: string) => {
  const funder = Keypair.random();

  const funded = await fetch(
    `https://friendbot.stellar.org?addr=${funder.publicKey()}`,
  );

  expect(funded.ok).toBe(true);

  const source = await horizon.loadAccount(funder.publicKey());

  const payment = new TransactionBuilder(source, {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: "100",
        destination: address,
        destAsset: usdc,
        destAmount: amount,
        path: [],
      }),
    )
    .setTimeout(60)
    .build();

  payment.sign(funder);
  await horizon.submitTransaction(payment);
};

const fill = async (page: Page, recipient: string, amount: string) => {
  await page.locator("#recipient").fill(recipient);
  await page.locator("#amount").fill(amount);
};

const review = (page: Page) =>
  page.getByRole("button", { name: "Revisar" }).click();

test("pays a username in USDC, resumes after a reload and explains refusals", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);

  const recipientContext = await browser.newContext(test.info().project.use);
  const recipient = freshUsername();

  await openWallet(await recipientContext.newPage(), recipient);
  await recipientContext.close();

  const sender = await openWallet(page, freshUsername());

  await fundWithUsdc(sender, "1");

  await page.goto("/send");
  await page.getByRole("link", { name: /1 USDC/ }).click();
  await fill(page, `@${recipient}`, "0.5");
  await review(page);

  const summary = page.getByRole("definition");

  await expect(
    page.getByRole("heading", { name: "Revisa tu pago" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(summary.filter({ hasText: `@${recipient}` })).toBeVisible();
  await expect(summary.filter({ hasText: /^USDC$/ })).toBeVisible();
  await expect(summary.filter({ hasText: /^0\.5$/ })).toBeVisible();
  await expect(page.getByText("Orchid paga la comisión")).toBeVisible();

  const approved = page.waitForResponse(
    (response) =>
      response.url().includes(serverFunction) &&
      (response.request().postData()?.includes('"signature"') ?? false),
  );

  await page.getByRole("button", { name: "Enviar" }).click();
  await approved;
  await expect(page).toHaveURL(/transfer=/);
  await page.reload();

  await expect(page.getByRole("heading", { name: "Enviado" })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText(`0.5 USDC a @${recipient}`)).toBeVisible();

  await page.getByRole("button", { name: "Listo" }).click();
  await expect(page).toHaveURL("/home");

  await page.goto("/send");
  await page.getByRole("link", { name: /0\.5 USDC/ }).click();
  await fill(page, `@${recipient}`, "5");
  await review(page);

  await expect(page.locator("#amount-error")).toHaveText(
    "Tienes 0.5 USDC disponibles",
    { timeout: 30_000 },
  );
  await expect(page.locator("#amount")).toBeFocused();

  const exchange = Keypair.random().publicKey();

  await page.route(`**${serverFunction}**`, (route) =>
    route.request().postData()?.includes(exchange)
      ? route.fulfill({
          json: {
            result: Schema.encodeSync(TransferStep)(
              new ExternalMemoRequired({
                address: Schema.decodeSync(AccountAddress)(exchange),
                exchange: "Exchange de prueba",
                source: "https://example.com/deposits",
              }),
            ),
          },
        })
      : route.continue(),
  );

  await fill(page, exchange, "0.1");
  await expect(page.locator("#memo")).toBeVisible();
  await review(page);

  await expect(page.locator("#memo-error")).toHaveText(
    "Este destino necesita memo: sin él tu dinero puede perderse",
    { timeout: 30_000 },
  );
  await expect(page.locator("#memo")).toBeFocused();
});
