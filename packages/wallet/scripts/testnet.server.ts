import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  Account,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { databaseLayer, makeDatabase } from "@workspace/db";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Approval,
  Opened,
  OpeningDraft,
  RecoveryDraft,
  SigningRequest,
  Username,
  WalletClaim,
  NeedsReopening,
  NotSponsored,
} from "../src/contract";
import { Applied, Chain, Rejected, Sealed } from "../src/server/Chain.server";
import { Directory, type WalletRow } from "../src/server/Directory.server";
import { Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { WalletSettings } from "../src/server/settings.server";
import {
  OpeningFacts,
  draftRecovery,
  readEnvelope,
  signingPayload,
} from "../src/stellar/envelopes";
import { baseFee, networkPassphrase, usdc } from "../src/stellar/network";

const secret = (name: string) => {
  const value = process.env[name];

  if (!value) throw new Error(`Missing verification environment variable ${name}`);

  return value;
};

const sponsor = Keypair.fromSecret(secret("RESERVE_SPONSOR_SECRET"));
const feePayer = Keypair.fromSecret(secret("FEE_PAYER_SECRET"));
const user = Keypair.fromSecret(secret("VERIFY_USER_SECRET"));
const activityUser = Keypair.fromSecret(secret("VERIFY_ACTIVITY_SECRET"));
const outsider = Keypair.fromSecret(secret("VERIFY_RECIPIENT_SECRET"));
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

const dbLayer = databaseLayer({
  connectionString: "postgres://orchid:orchid-local@127.0.0.1:55433/wallet_live",
});

const dependencies = Layer.mergeAll(Chain.layer, Directory.layer, Transfers.layer);

const services = Layer.merge(
  Wallet.serviceLayer.pipe(Layer.provide(dependencies)),
  dependencies,
).pipe(
  Layer.provide(
    Layer.succeed(WalletSettings, {
      rpcUrl: "https://soroban-testnet.stellar.org",
      reserveSponsorSecret: Redacted.make(sponsor.secret()),
      feePayerSecret: Redacted.make(feePayer.secret()),
    }),
  ),
  Layer.provide(dbLayer),
);

const run = <A, E>(program: Effect.Effect<A, E, Wallet | Chain | Directory | Transfers>) =>
  Effect.runPromise(program.pipe(Effect.provide(services)));

const addressOf = (key: Keypair) => Schema.decodeSync(AccountAddress)(key.publicKey());

const approve = (request: SigningRequest, key: Keypair) =>
  Option.some(new Approval({ signature: key.sign(signingPayload(request.envelope)) }));

const hashes: Array<{ label: string; hash: string }> = [];

const remember = (label: string, hash: string) => {
  hashes.push({ label, hash });
  console.log(`${label}: ${hash}`);
};

const walletRow = async (address: AccountAddress): Promise<WalletRow> =>
  Option.getOrThrow(await run(Directory.use((directory) => directory.byAddress(address))));

const fund = async (key: Keypair) => {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${key.publicKey()}`);

  assert.equal(response.status, 200, "Friendbot funding failed");
};

const opening = (claim: WalletClaim, approval: Option.Option<Approval> = Option.none()) =>
  run(Wallet.use((wallet) => wallet.open(claim, approval)));

const waitApplied = async (sealed: Sealed) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const settlement = await run(Chain.use((chain) => chain.settlement(sealed)));

    if (settlement instanceof Applied) return;

    if (settlement instanceof Rejected)
      throw new Error(`Verification transaction rejected: ${settlement.code}`);

    await run(Chain.use((chain) => chain.submit(sealed)));
    await Bun.sleep(1000);
  }

  throw new Error("Verification transaction did not settle in 60 seconds");
};

const createWithShortRecovery = async (key: Keypair, name: string) => {
  const address = addressOf(key);
  const claim = new WalletClaim({ address, username: Schema.decodeSync(Username)(name) });
  const draft = await opening(claim);

  assert.ok(draft instanceof OpeningDraft);
  await opening(claim, approve(draft.request, key));

  const stored = await walletRow(address);

  assert.ok(stored.attemptEnvelope && stored.attemptHash && stored.attemptExpiresAt);

  const sealed = new Sealed({
    envelope: stored.attemptEnvelope,
    hash: stored.attemptHash,
    expiresAt: DateTime.makeUnsafe(stored.attemptExpiresAt),
  });

  await waitApplied(sealed);
  remember(`${name} opening`, sealed.hash);

  const sponsorship = Option.getOrThrow(await run(Chain.use((chain) => chain.account(address))));

  assert.ok(
    sponsorship.accountSponsored && sponsorship.sponsored,
    "Raw extXdr must identify Orchid as both sponsors",
  );

  const account = await horizon.loadAccount(address);
  const native = account.balances.find((balance) => balance.asset_type === "native");

  assert.equal(native?.balance, "0.0000000");
  assert.equal(account.num_sponsored, 3);

  // Only this local verification driver shortens the server-built recovery time.
  // The production request path always uses stellar/network.ts policy constants.
  const minTime = Math.floor(Date.now() / 1000) + 30;
  const maxTime = minTime + 120;

  const recovery = new SigningRequest({
    envelope: draftRecovery({
      source: new Account(address, account.sequence),
      reserveSponsor: addressOf(sponsor),
      minTime,
      maxTime,
    }),
    expiresAt: DateTime.makeUnsafe(maxTime * 1000),
  });

  await run(Directory.use((directory) => directory.recoveryDraft(stored, recovery)));
  assert.ok((await opening(claim)) instanceof RecoveryDraft);
  assert.ok((await opening(claim, approve(recovery, key))) instanceof Opened);

  const active = await walletRow(address);

  assert.ok(active.recoveryEnvelope && active.recoveryHash && active.recoveryMaxTime);
  assert.equal(
    (await server.getTransaction(active.recoveryHash)).status,
    rpc.Api.GetTransactionStatus.NOT_FOUND,
  );

  return {
    claim,
    minTime,
    sealed: new Sealed({
      envelope: active.recoveryEnvelope,
      hash: active.recoveryHash,
      expiresAt: DateTime.makeUnsafe(active.recoveryMaxTime),
    }),
  };
};

assert.equal((await server.getNetwork()).passphrase, networkPassphrase);

await Effect.runPromise(
  Effect.gen(function* () {
    const db = yield* makeDatabase();

    yield* migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
  }).pipe(Effect.provide(dbLayer)),
);

await fund(sponsor);

await fund(feePayer);

console.log("Friendbot funded fresh, separate reserve sponsor and fee payer.");

await fund(outsider);

const outsiderClaim = new WalletClaim({
  address: addressOf(outsider),
  username: Schema.decodeSync(Username)("verify_outsider"),
});

assert.ok((await opening(outsiderClaim)) instanceof NotSponsored);

assert.ok(
  Option.isNone(
    await run(Directory.use((directory) => directory.byAddress(outsiderClaim.address))),
  ),
);

console.log(
  "PASS sponsorship gate rejects a fresh Friendbot account before claiming its username.",
);

const first = await createWithShortRecovery(user, "verify_recovery");

const early = await server.sendTransaction(
  TransactionBuilder.fromXDR(first.sealed.envelope, networkPassphrase),
);

const outerResult = early.errorResult?.result;

const earlyCode =
  outerResult?.type === "txFeeBumpInnerFailed"
    ? outerResult.innerResultPair.result.result.type
    : outerResult?.type;

assert.equal(earlyCode, "txTooEarly");

console.log("Stored recovery was unsubmitted; early probe rejected txTooEarly.");

while (Number((await server.getLatestLedger()).closeTime) < first.minTime) await Bun.sleep(1000);

await run(Wallet.use((wallet) => wallet.sweep));

await waitApplied(first.sealed);

await run(Wallet.use((wallet) => wallet.sweep));

remember("bounded recovery", first.sealed.hash);

assert.equal((await walletRow(first.claim.address)).status, "recovered");

assert.ok(
  (await run(Wallet.use((wallet) => wallet.overview(first.claim.address)))) instanceof
    NeedsReopening,
);

const reopened = await opening(first.claim);

assert.ok(reopened instanceof OpeningDraft);

await opening(first.claim, approve(reopened.request, user));

let step = await opening(first.claim);

for (let attempt = 0; attempt < 60 && !(step instanceof RecoveryDraft); attempt++) {
  await Bun.sleep(1000);
  step = await opening(first.claim);
}

assert.ok(step instanceof RecoveryDraft);

assert.ok((await opening(first.claim, approve(step.request, user))) instanceof Opened);

const reopenedRow = await walletRow(first.claim.address);

assert.ok(reopenedRow.attemptHash);

remember("same-key same-username reopening", reopenedRow.attemptHash);

const repairSource = await server.getAccount(first.claim.address);

const removeTrust = new TransactionBuilder(repairSource, { fee: baseFee, networkPassphrase })
  .addOperation(Operation.changeTrust({ asset: usdc, limit: "0" }))
  .setTimeout(120)
  .build();

removeTrust.sign(user);

const removeOuter = TransactionBuilder.buildFeeBumpTransaction(
  feePayer.publicKey(),
  baseFee,
  removeTrust,
  networkPassphrase,
);

removeOuter.sign(feePayer);

const removal = new Sealed({
  envelope: removeOuter.toXDR(),
  hash: Array.from(removeOuter.hash(), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  expiresAt: DateTime.makeUnsafe(Date.now() + 120000),
});

await waitApplied(removal);

remember("external trustline removal", removal.hash);

assert.ok(
  (await run(Wallet.use((wallet) => wallet.overview(first.claim.address)))) instanceof
    NeedsReopening,
);

const repair = await opening(first.claim);

assert.ok(repair instanceof OpeningDraft);

const repairFacts = Option.getOrThrow(readEnvelope(repair.request.envelope));

assert.ok(repairFacts instanceof OpeningFacts);

assert.equal(repairFacts.createAccount, false);

await opening(first.claim, approve(repair.request, user));

let repairStep = await opening(first.claim);

for (let attempt = 0; attempt < 60 && !(repairStep instanceof RecoveryDraft); attempt++) {
  await Bun.sleep(1000);
  repairStep = await opening(first.claim);
}

assert.ok(repairStep instanceof RecoveryDraft);

assert.ok((await opening(first.claim, approve(repairStep.request, user))) instanceof Opened);

const repaired = await walletRow(first.claim.address);

assert.ok(repaired.attemptHash);

remember("sponsored trustline-only repair", repaired.attemptHash);

const second = await createWithShortRecovery(activityUser, "verify_activity");
const holder = await server.getAccount(second.claim.address);

const bump = new TransactionBuilder(holder, { fee: baseFee, networkPassphrase })
  .addOperation(
    Operation.bumpSequence({ bumpTo: (BigInt(holder.sequenceNumber()) + 1n).toString() }),
  )
  .setTimeout(120)
  .build();

bump.sign(activityUser);

const feeBump = TransactionBuilder.buildFeeBumpTransaction(
  feePayer.publicKey(),
  baseFee,
  bump,
  networkPassphrase,
);

feeBump.sign(feePayer);

const activity = new Sealed({
  envelope: feeBump.toXDR(),
  hash: Array.from(feeBump.hash(), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  expiresAt: DateTime.makeUnsafe(Date.now() + 120000),
});

// Submit the same signed inner transaction under a different fee payer.
const alternate = TransactionBuilder.buildFeeBumpTransaction(
  sponsor.publicKey(),
  baseFee,
  bump,
  networkPassphrase,
);

alternate.sign(sponsor);

const replacement = new Sealed({
  envelope: alternate.toXDR(),
  hash: Array.from(alternate.hash(), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  expiresAt: activity.expiresAt,
});

await waitApplied(replacement);

remember("device activity under alternate fee payer", replacement.hash);

assert.equal(
  (await server.getTransaction(activity.hash)).status,
  rpc.Api.GetTransactionStatus.NOT_FOUND,
);

assert.ok((await run(Chain.use((chain) => chain.settlement(activity)))) instanceof Applied);

console.log(
  "PASS settlement resolves the original intent through its included inner hash under an alternate fee payer.",
);

let consumed = await run(Chain.use((chain) => chain.settlement(second.sealed)));

for (let attempt = 0; attempt < 30 && !(consumed instanceof Rejected); attempt++) {
  await Bun.sleep(1000);
  consumed = await run(Chain.use((chain) => chain.settlement(second.sealed)));
}

assert.ok(consumed instanceof Rejected);

assert.equal(consumed.code, "sequence_consumed");

console.log(
  "PASS absent recovery reaches sequence_consumed after a different transaction consumes its sequence.",
);

while (Number((await server.getLatestLedger()).closeTime) < second.minTime) await Bun.sleep(1000);

await run(Wallet.use((wallet) => wallet.sweep));

assert.equal(
  (await server.getTransaction(second.sealed.hash)).status,
  rpc.Api.GetTransactionStatus.NOT_FOUND,
);

assert.equal((await walletRow(second.claim.address)).status, "active");

console.log("Sweep skipped recovery after the device advanced its sequence.");

const result = {
  verifiedAt: new Date().toISOString(),
  network: "testnet",
  reserveSponsor: sponsor.publicKey(),
  feePayer: feePayer.publicKey(),
  hashes,
  checks: [
    "raw getLedgerEntries extXdr identifies configured sponsor on account and trustline",
    "unsponsored Friendbot account refused before username claim",
    "0 XLM sponsored opening + USDC trustline",
    "two-stage opening stores recovery unsubmitted",
    "recovery txTooEarly before minTime",
    "bounded recovery after minTime",
    "recovered state",
    "same-key same-username reopening",
    "sponsored trustline-only repair",
    "sweep skips changed sequence",
    "settlement discovers inner inclusion under alternate fee payer while original outer is NOT_FOUND",
    "consumed sequence plus complete inner absence evidence concludes sequence_consumed",
  ],
  deferred: [
    "Live USDC payment and nonzero-USDC recovery guard require Circle testnet USDC funding; covered by local behavioral tests.",
  ],
};

writeFileSync(
  `${import.meta.dir}/../verification/testnet.json`,
  `${JSON.stringify(result, null, 2)}\n`,
);

console.log(
  "PASS live testnet verification; public evidence written to verification/testnet.json.",
);
