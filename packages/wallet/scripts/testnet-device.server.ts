import assert from "node:assert/strict";
import {
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { databaseLayer, makeDatabase } from "@workspace/db";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  type CreateOutcome,
  type DeviceWallet,
  Holding,
  type KeyStore,
  Opened,
  PositiveAmount,
  Restored,
  type SendOutcome,
  Settled,
  TransferIntent,
  Username,
  UsernameRecipient,
  assetKey,
  baseAsset,
  makeWalletClient,
} from "@workspace/wallet";
import { signingKey } from "../src/device/signing";
import { SoftwareAuthenticator } from "../test/software-authenticator";
import { Chain } from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import { Transfers } from "../src/server/Transfers.server";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Backups } from "../src/server/Backups.server";
import { Wallet } from "../src/server/Wallet.server";
import { WalletSettings } from "../src/server/settings.server";
import { baseFee, networkPassphrase, usdc } from "../src/stellar/network";

const secret = (name: string) => {
  const value = process.env[name];

  if (!value)
    throw new Error(`Missing verification environment variable ${name}`);

  return value;
};

const sponsor = Keypair.fromSecret(secret("RESERVE_SPONSOR_SECRET"));
const feePayer = Keypair.fromSecret(secret("FEE_PAYER_SECRET"));
const rpcUrl = "https://soroban-testnet.stellar.org";
const passkeyOrigin = "http://localhost:3000";
const authenticator = new SoftwareAuthenticator(passkeyOrigin);
const server = new rpc.Server(rpcUrl);
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

const dbLayer = databaseLayer({
  connectionString:
    "postgres://orchid:orchid-local@127.0.0.1:55433/wallet_live",
});

const dependencies = Layer.mergeAll(
  Chain.layer,
  Directory.layer,
  Transfers.layer,
  AssetOrders.layer,
  Backups.layer,
);

const services = Layer.merge(
  Wallet.serviceLayer.pipe(Layer.provide(dependencies)),
  dependencies,
).pipe(
  Layer.provide(
    Layer.succeed(WalletSettings, {
      rpcUrl,
      reserveSponsorSecret: Redacted.make(sponsor.secret()),
      feePayerSecret: Redacted.make(feePayer.secret()),
      passkeyOrigins: [passkeyOrigin],
    }),
  ),
  Layer.provide(dbLayer),
  Layer.provide(FetchHttpClient.layer),
);

const runtime = ManagedRuntime.make(services);

const run = <A, E>(program: Effect.Effect<A, E, Wallet | Chain | Directory>) =>
  runtime.runPromise(program);

function memoryKeyStore() {
  let saved = Option.none<DeviceWallet>();

  const store: KeyStore = {
    read: () => Effect.sync(() => saved),
    write: (wallet) =>
      Effect.sync(() => {
        saved = Option.some(wallet);
      }),
  };

  return { store, saved: () => saved };
}

const device = memoryKeyStore();

const openWallet = async (
  client: ReturnType<typeof makeWalletClient>,
  username: string,
) => {
  let opened: CreateOutcome = await client.create(username);

  for (
    let attempt = 0;
    attempt < 3 && Predicate.isTagged(opened, "OpeningPending");
    attempt++
  )
    opened = await client.create(username);

  assert.ok(opened instanceof Opened, `Expected Opened, got ${opened._tag}`);

  return opened;
};

assert.equal((await server.getNetwork()).passphrase, networkPassphrase);

await Effect.runPromise(
  Effect.gen(function* () {
    const db = yield* makeDatabase();

    yield* migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
  }).pipe(Effect.provide(dbLayer)),
);

const client = makeWalletClient(
  await run(Wallet),
  device.store,
  authenticator.passkeys,
);

const freshUsername = () =>
  `device_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const username = freshUsername();
const outcome = await openWallet(client, username);
const wallet = Option.getOrThrow(device.saved());
const key = signingKey(wallet.phrase);

assert.equal(outcome.profile.username, username);

assert.equal(outcome.profile.address, wallet.address);

assert.equal(key.publicKey(), wallet.address);

assert.equal(wallet.phrase.split(" ").length, 12);

assert.equal(wallet.reserveSponsor, sponsor.publicKey());

console.log(
  "PASS device client opened a wallet whose key derives from its stored secret phrase.",
);

const sponsorship = Option.getOrThrow(
  await run(Chain.use((chain) => chain.account(wallet.address))),
);

assert.ok(sponsorship.accountSponsored && sponsorship.sponsored);

const account = await horizon.loadAccount(wallet.address);

const native = account.balances.find(
  (balance) => balance.asset_type === "native",
);

const trustline = account.balances.find(
  (balance) =>
    balance.asset_type === "credit_alphanum4" &&
    balance.asset_code === usdc.code &&
    balance.asset_issuer === usdc.issuer,
);

assert.equal(native?.balance, "0.0000000");

assert.ok(trustline, "USDC trustline must exist");

assert.equal(account.num_sponsored, 3);

console.log(
  "PASS account and USDC trustline exist on testnet with 0 XLM, sponsored by Orchid.",
);

const row = Option.getOrThrow(
  await run(Directory.use((directory) => directory.byAddress(wallet.address))),
);

assert.equal(row.status, "active");

assert.ok(row.attemptHash && row.recoveryEnvelope && row.recoveryHash);

const sealedRecovery = TransactionBuilder.fromXDR(
  row.recoveryEnvelope,
  networkPassphrase,
);

const recovery =
  sealedRecovery instanceof FeeBumpTransaction
    ? sealedRecovery.innerTransaction
    : sealedRecovery;

const [removal, merge] = recovery.operations;

assert.equal(recovery.source, wallet.address);

assert.equal(removal?.type, "changeTrust");

assert.equal(merge?.type, "accountMerge");

assert.equal(
  merge.type === "accountMerge" && merge.destination,
  sponsor.publicKey(),
);

assert.ok(
  recovery.signatures.some((signature) =>
    Keypair.fromPublicKey(wallet.address).verify(
      recovery.hash(),
      signature.signature.toXdrObject(),
    ),
  ),
  "Stored recovery must carry the device signature",
);

console.log(
  "PASS stored recovery is signed by the device key and merges into the reserve sponsor.",
);

const overview = await client.overview();

assert.ok(
  overview instanceof Holding,
  `Expected Holding, got ${overview._tag}`,
);

assert.equal(overview.profile.username, username);

assert.equal(
  overview.balances.find(
    (balance) => assetKey(balance.asset) === assetKey(baseAsset),
  )?.amount,
  0n,
);

console.log("PASS overview reads the opened wallet with a zero USDC balance.");

const recipientName = freshUsername();

await openWallet(
  makeWalletClient(
    await run(Wallet),
    memoryKeyStore().store,
    new SoftwareAuthenticator(passkeyOrigin).passkeys,
  ),
  recipientName,
);

const usdcFunder = Keypair.fromSecret(secret("USDC_FUNDER_SECRET"));
const funder = await horizon.loadAccount(usdcFunder.publicKey());

const funding = new TransactionBuilder(funder, {
  fee: baseFee,
  networkPassphrase,
})
  .addOperation(
    Operation.payment({
      destination: wallet.address,
      asset: usdc,
      amount: "1",
    }),
  )
  .setTimeout(60)
  .build();

funding.sign(usdcFunder);

await horizon.submitTransaction(funding);

const payment = new TransferIntent({
  to: UsernameRecipient.make({
    value: Schema.decodeSync(Username)(recipientName),
  }),
  asset: baseAsset,
  amount: Schema.decodeSync(PositiveAmount)("5000000"),
});

let sent: SendOutcome = await client.send(payment);

for (
  let attempt = 0;
  attempt < 3 && Predicate.isTagged(sent, "Pending");
  attempt++
)
  sent = await client.send(payment);

assert.ok(sent instanceof Settled, `Expected Settled, got ${sent._tag}`);

assert.equal(sent.claimable, undefined);

const paymentRecord = (
  await horizon
    .transactions()
    .forAccount(wallet.address)
    .order("desc")
    .limit(5)
    .call()
).records.find((record) => record.source_account === wallet.address);

assert.ok(paymentRecord?.successful, "Payment must be applied on testnet");

console.log(
  `PASS device client paid 0.5 USDC from ${username} to ${recipientName} in ${paymentRecord.hash}.`,
);

let restoredWallet = Option.none<DeviceWallet>();

const restoringClient = makeWalletClient(
  await run(Wallet),
  {
    read: () => Effect.sync(() => restoredWallet),
    write: (wallet) =>
      Effect.sync(() => {
        restoredWallet = Option.some(wallet);
      }),
  },
  authenticator.passkeys,
);

const restored = await restoringClient.restore();

assert.ok(
  restored instanceof Restored,
  `Expected Restored, got ${restored._tag}`,
);

assert.equal(restored.profile.username, username);

assert.equal(Option.getOrThrow(restoredWallet).phrase, wallet.phrase);

assert.ok((await restoringClient.overview()) instanceof Holding);

console.log(
  "PASS a second device restores the same wallet from its passkey backup.",
);

console.log(
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      network: "testnet",
      username,
      address: wallet.address,
      reserveSponsor: sponsor.publicKey(),
      feePayer: feePayer.publicKey(),
      openingHash: row.attemptHash,
      recoveryHash: row.recoveryHash,
      paymentRecipient: recipientName,
      paymentHash: paymentRecord.hash,
      checks: [
        "device client generated, stored and reused a 12-word SEP-5 secret phrase",
        "opening and recovery approved by the device client against real testnet drafts",
        "raw extXdr identifies Orchid as account and trustline sponsor; 0 XLM, num_sponsored 3",
        "stored recovery signed by the derived key and merging into the reserve sponsor",
        "overview returns Holding with a zero USDC balance",
        "the device client approved a USDC payment draft between two Orchid usernames and it settled on testnet",
        "a second device restores the same secret phrase and username from the passkey backup",
      ],
    },
    null,
    2,
  ),
);

console.log("PASS live device verification; public evidence printed above.");

await runtime.dispose();
