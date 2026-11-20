import { type Page, type Route, expect, test } from "@playwright/test";
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
  ServerFailure,
  ServiceFailed,
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

const choose = (page: Page, destination: "address" | "username") =>
  page.getByTestId(`choose-${destination}`).click();

const fill = async (page: Page, recipient: string, amount: string) => {
  await page.getByRole("textbox").fill(recipient);
  await page.getByTestId("continue-recipient").click();
  await page.getByRole("textbox").fill(amount);
};

const review = (page: Page) => page.getByTestId("review-payment").click();

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

  await choose(page, "username");
  await fill(page, recipient, "0.5");

  const reviewRequest = page.waitForRequest(
    (request) =>
      request.url().includes(serverFunction) &&
      (request.postData()?.includes(recipient) ?? false),
  );

  await review(page);

  const summary = page.getByRole("definition");

  await expect(page.getByTestId("confirm-payment")).toBeVisible({
    timeout: 30_000,
  });
  await expect(summary.filter({ hasText: `@${recipient}` })).toBeVisible();
  await expect(summary.filter({ hasText: /^USDC$/ })).toBeVisible();
  await expect(summary.filter({ hasText: /^0\.5$/ })).toBeVisible();

  const transferRequest = await reviewRequest;

  const approved = page.waitForResponse(
    (response) =>
      response.url().includes(serverFunction) &&
      (response.request().postData()?.includes('"signature"') ?? false),
  );

  await page.getByTestId("confirm-payment").click();
  await approved;
  await expect(page).toHaveURL(/transfer=/);
  await page.reload();

  await expect(page.getByRole("status")).toHaveAttribute(
    "data-outcome",
    "Settled",
    {
      timeout: 90_000,
    },
  );

  await page.getByTestId("result-home").click();
  await expect(page).toHaveURL("/home");

  await page.goto("/send");
  await page.getByRole("link", { name: /0\.5 USDC/ }).click();
  await choose(page, "username");
  await fill(page, recipient, "5");
  await review(page);

  await expect(page.getByRole("textbox")).toHaveAttribute(
    "aria-invalid",
    "true",
    { timeout: 30_000 },
  );
  await expect(page.getByRole("textbox")).toBeFocused();

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

  await page.getByTestId("change-recipient").click();
  await page.getByTestId("change-destination").click();
  await choose(page, "address");
  await fill(page, exchange, "0.1");
  await expect(page.getByTestId("edit-memo")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveCount(0);
  await review(page);

  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveAttribute(
    "aria-invalid",
    "true",
    { timeout: 30_000 },
  );
  await expect(page.getByRole("dialog").getByRole("textbox")).toBeFocused();
  await page.getByRole("dialog").getByRole("textbox").fill("4521");
  await page.getByTestId("save-memo").click();
  await expect(page.getByTestId("edit-memo")).toBeVisible();

  const sendUsdc = page.url();

  const answerFor = async (
    answer: (route: Route) => Promise<void>,
    expected: "ServerUnreachable" | "InvalidResponse" | "ServiceFailed",
  ) => {
    const marker = Keypair.random().publicKey();

    await page.route(`**${serverFunction}**`, (route) =>
      route.request().postData()?.includes(marker)
        ? answer(route)
        : route.fallback(),
    );
    await page.goto(sendUsdc);
    await choose(page, "address");
    await fill(page, marker, "0.1");
    await review(page);
    await expect(page.getByRole("status")).toHaveAttribute(
      "data-outcome",
      expected,
      {
        timeout: 30_000,
      },
    );
  };

  await answerFor(
    (route) => route.abort("connectionrefused"),
    "ServerUnreachable",
  );
  await expect(page.getByTestId("result-again")).toBeVisible();

  await page.goto(sendUsdc);
  await choose(page, "address");
  await fill(page, Keypair.random().publicKey(), "0.1");
  await page.context().setOffline(true);
  await review(page);
  await expect(page.getByRole("status")).toHaveAttribute(
    "data-outcome",
    "Offline",
    {
      timeout: 30_000,
    },
  );
  await page.context().setOffline(false);

  await answerFor(
    (route) =>
      route.fulfill({ contentType: "text/html", body: "<html>502</html>" }),
    "InvalidResponse",
  );

  await answerFor(
    (route) =>
      route.fulfill({
        json: { result: Schema.encodeSync(ServerFailure)(new ServiceFailed()) },
      }),
    "ServiceFailed",
  );
  await expect(page.getByTestId("result-again")).toHaveCount(0);

  const reviewed = transferRequest.postData() ?? "";

  expect(reviewed).toContain('"USDC"');

  const tampered = await page.request.post(transferRequest.url(), {
    headers: await transferRequest.allHeaders(),
    data: reviewed.replace('"USDC"', '"U$DC"'),
  });

  const answered = await tampered.text();

  expect(answered).toContain("ServiceFailed");
  expect(answered).not.toMatch(/AssetCode|Expected|pattern|issue/i);
});
