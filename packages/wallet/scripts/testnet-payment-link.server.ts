import assert from "node:assert/strict";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AssetSettled,
  BalanceGone,
  Holding,
  Offline,
  OpenPaymentLinks,
  Opened,
  PaymentLinkCreated,
  PaymentLinkIntent,
  PositiveAmount,
  ResolvedPaymentLink,
  type WalletPort,
  assetKey,
  baseAsset,
  makeWalletClient,
} from "@workspace/wallet";
import { Chain } from "../src/server/Chain.server";
import { Wallet } from "../src/server/Wallet.server";
import { networkPassphrase } from "../src/stellar/network";
import { SoftwareAuthenticator } from "../test/software-authenticator";
import {
  freshDatabase,
  memoryKeyStore,
  openThroughReview,
  rpcUrl,
  walletServices,
} from "./live.server";
import { fundWithFriendbot, fundWithUsdc, horizon } from "./testnet-funding";

const sponsor = Keypair.random();
const feePayer = Keypair.random();
const passkeyOrigin = "http://localhost:3000";
const authenticator = new SoftwareAuthenticator(passkeyOrigin);
const server = new rpc.Server(rpcUrl);

const services = walletServices(await freshDatabase(), {
  sponsor,
  feePayer,
  passkeyOrigins: [passkeyOrigin],
});

const runtime = ManagedRuntime.make(services);

const run = <A, E>(program: Effect.Effect<A, E, Wallet | Chain>) =>
  runtime.runPromise(program);

const openWallet = async (
  client: ReturnType<typeof makeWalletClient>,
  username: string,
) => {
  const opened = await openThroughReview(client, username);

  assert.ok(opened instanceof Opened, `Expected Opened, got ${opened._tag}`);

  return opened;
};

const usdcBalanceOf = async (client: ReturnType<typeof makeWalletClient>) => {
  const overview = await client.overview();

  assert.ok(
    overview instanceof Holding,
    `Expected Holding, got ${overview._tag}`,
  );

  return (
    overview.balances.find(
      (balance) => assetKey(balance.asset) === assetKey(baseAsset),
    )?.amount ?? 0n
  );
};

const latestTxHash = async (address: string) => {
  const page = await horizon
    .transactions()
    .forAccount(address)
    .order("desc")
    .limit(5)
    .call();

  const record = page.records.find(
    (entry) => entry.source_account === address && entry.successful,
  );

  assert.ok(record, `Expected a successful transaction for ${address}`);

  return record.hash;
};

assert.equal((await server.getNetwork()).passphrase, networkPassphrase);

await Promise.all(
  [sponsor, feePayer].map((key) => fundWithFriendbot(key.publicKey())),
);

const walletService = await run(Wallet);
const device = memoryKeyStore();

const client = makeWalletClient(
  walletService,
  device.store,
  authenticator.passkeys,
);

const username = `link_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

await openWallet(client, username);

const wallet = Option.getOrThrow(device.saved());

await fundWithUsdc(wallet.address, "1");

const balanceBefore = await usdcBalanceOf(client);

assert.equal(balanceBefore, 10_000_000n);

const linkAmount = Schema.decodeSync(PositiveAmount)("5000000");

const created = await client.createPaymentLink(
  new PaymentLinkIntent({ asset: baseAsset, amount: linkAmount }),
);

assert.ok(
  created instanceof PaymentLinkCreated,
  `Expected PaymentLinkCreated, got ${created._tag}`,
);

const createTxHash = await latestTxHash(wallet.address);

const liveEntries = await run(
  Chain.use((chain) => chain.claimable([created.balance])),
);

assert.equal(liveEntries.length, 1);

const liveEntry = liveEntries[0];

assert.ok(liveEntry);

assert.equal(liveEntry.sponsored, true);

assert.equal(liveEntry.amount, linkAmount);

assert.equal(liveEntry.claimants.length, 2);

assert.ok(
  liveEntry.claimants.every(
    (claimant) => claimant.predicate.type === "claimPredicateUnconditional",
  ),
);

const balanceHeld = await usdcBalanceOf(client);

assert.equal(balanceHeld, 5_000_000n);

const listed = await client.paymentLinks();

assert.ok(
  listed instanceof OpenPaymentLinks,
  `Expected OpenPaymentLinks, got ${listed._tag}`,
);

assert.deepEqual(
  listed.links.map((item) => item.balance),
  [created.balance],
);

const cancelled = await client.cancelPaymentLink(created);

assert.ok(
  cancelled instanceof AssetSettled,
  `Expected AssetSettled, got ${cancelled._tag}`,
);

const cancelTxHash = await latestTxHash(wallet.address);

const balanceAfterCancel = await usdcBalanceOf(client);

assert.equal(balanceAfterCancel, 10_000_000n);

const afterCancelEntries = await run(
  Chain.use((chain) => chain.claimable([created.balance])),
);

assert.equal(afterCancelEntries.length, 0);

const cancelAgain = await client.cancelPaymentLink(created);

assert.ok(
  cancelAgain instanceof BalanceGone && cancelAgain.status === "reclaimed",
  `Expected BalanceGone(reclaimed), got ${cancelAgain._tag}`,
);

const crashPort: WalletPort = {
  ...walletService,
  transfer: (order, approval) =>
    Option.isSome(approval)
      ? walletService
          .transfer(order, approval)
          .pipe(Effect.andThen(Effect.fail(new Offline())))
      : walletService.transfer(order, approval),
};

const crashedClient = makeWalletClient(
  crashPort,
  device.store,
  authenticator.passkeys,
);

const crashedOutcome = await crashedClient.createPaymentLink(
  new PaymentLinkIntent({ asset: baseAsset, amount: linkAmount }),
);

assert.ok(
  crashedOutcome instanceof Offline,
  `Expected Offline on simulated crash, got ${crashedOutcome._tag}`,
);

const restartedClient = makeWalletClient(
  walletService,
  device.store,
  authenticator.passkeys,
);

let resolved = await restartedClient.resolvePaymentLink();

for (
  let attempt = 0;
  attempt < 10 && Predicate.isTagged(resolved, "Pending");
  attempt++
) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  resolved = await restartedClient.resolvePaymentLink();
}

assert.ok(
  resolved instanceof ResolvedPaymentLink,
  `Expected ResolvedPaymentLink, got ${resolved._tag}`,
);

const restartCreateTxHash = await latestTxHash(wallet.address);

const restartCancelled = await restartedClient.cancelPaymentLink(resolved);

assert.ok(
  restartCancelled instanceof AssetSettled,
  `Expected AssetSettled for restarted link cancel, got ${restartCancelled._tag}`,
);

const restartCancelTxHash = await latestTxHash(wallet.address);

const finalBalance = await usdcBalanceOf(restartedClient);

assert.equal(finalBalance, 10_000_000n);

console.log(
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      network: "testnet",
      testnetResetNote: "Testnet hashes expire on the 2026-12-16 reset",
      username,
      sender: wallet.address,
      reserveSponsor: sponsor.publicKey(),
      feePayer: feePayer.publicKey(),
      firstLink: {
        address: created.address,
        balanceId: created.balance,
        createTxHash,
        cancelTxHash,
        balanceBefore: balanceBefore.toString(),
        balanceWhileOpen: balanceHeld.toString(),
        balanceAfterCancel: balanceAfterCancel.toString(),
      },
      restartedLink: {
        address: resolved.address,
        balanceId: resolved.balance,
        createTxHash: restartCreateTxHash,
        cancelTxHash: restartCancelTxHash,
        finalBalance: finalBalance.toString(),
      },
    },
    null,
    2,
  ),
);

await runtime.dispose();
