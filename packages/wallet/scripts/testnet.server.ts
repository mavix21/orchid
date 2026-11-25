import assert from "node:assert/strict";
import {
  Account,
  Asset,
  Keypair,
  MuxedAccount,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  ActivityPage,
  AddressRecipient,
  Approval,
  type Approvals,
  DepositActivity,
  type DestinationAddress,
  ExternalMemoRequired,
  MemoNotAllowed,
  MuxedAddress,
  NativeAsset,
  PaymentMemo,
  PositiveAmount,
  Settled,
  TransferDraft,
  TransferId,
  TransferOrder,
  Opened,
  OpeningDraft,
  RecoveryDraft,
  SigningRequest,
  Username,
  WalletClaim,
  NeedsReopening,
  UsernameTaken,
  NotSponsored,
} from "../src/contract";
import { Applied, Chain, Rejected, Sealed } from "../src/server/Chain.server";
import { Directory, type WalletRow } from "../src/server/Directory.server";
import { Authorized, Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { requestsOf } from "../src/device/opening-drafts";
import { pairedCreation } from "./testnet-paired-creation.server";
import {
  OpeningFacts,
  readEnvelope,
  signingPayload,
} from "../src/stellar/envelopes";
import { baseFee, networkPassphrase, usdc } from "../src/stellar/network";
import { freshDatabase, rpcUrl, walletServices } from "./live.server";
import { fundWithFriendbot, fundWithUsdc, horizon } from "./testnet-funding";
import { memoRequiredDataName } from "../src/server/exchange-memos.server";

const sponsor = Keypair.random();
const feePayer = Keypair.random();
const user = Keypair.random();
const activityUser = Keypair.random();
const outsider = Keypair.random();
const exchangeKey = Keypair.random();
const exchange = Schema.decodeSync(AccountAddress)(exchangeKey.publicKey());
const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const recoveryName = `vr_${runId}`;

const server = new rpc.Server(rpcUrl);

const services = walletServices(await freshDatabase(), {
  sponsor,
  feePayer,
  passkeyOrigins: [],
});

const run = <A, E>(
  program: Effect.Effect<A, E, Wallet | Chain | Directory | Transfers>,
) => Effect.runPromise(program.pipe(Effect.provide(services)));

const addressOf = (key: Keypair) =>
  Schema.decodeSync(AccountAddress)(key.publicKey());

const approval = (request: SigningRequest, key: Keypair) =>
  new Approval({ signature: key.sign(signingPayload(request.envelope)) });

const approve = (request: SigningRequest, key: Keypair) =>
  Option.some(approval(request, key));

const hexHash = (transaction: { hash(): Uint8Array }) =>
  Array.from(transaction.hash(), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const hashes: Array<{ label: string; hash: string }> = [];

const remember = (label: string, hash: string) => {
  hashes.push({ label, hash });
  console.log(`${label}: ${hash}`);
};

const walletRow = async (address: AccountAddress): Promise<WalletRow> =>
  Option.getOrThrow(
    await run(Directory.use((directory) => directory.byAddress(address))),
  );

const opening = (
  claim: WalletClaim,
  approvals: Option.Option<Approvals> = Option.none(),
) => run(Wallet.use((wallet) => wallet.open(claim, approvals)));

const approvedBy = (
  key: Keypair,
  draft: OpeningDraft | RecoveryDraft,
): Option.Option<Approvals> =>
  Option.some(Arr.map(requestsOf(draft), (request) => approval(request, key)));

const untilOpened = async (claim: WalletClaim) => {
  let step = await opening(claim);

  for (let attempt = 0; attempt < 60 && !(step instanceof Opened); attempt++) {
    await Bun.sleep(1000);
    step = await opening(claim);
  }

  return step;
};

const waitApplied = async (sealed: Sealed) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const settlement = await run(
      Chain.use((chain) => chain.settlement(sealed)),
    );

    if (settlement instanceof Applied) return;

    if (settlement instanceof Rejected)
      throw new Error(`Verification transaction rejected: ${settlement.code}`);

    await run(Chain.use((chain) => chain.submit(sealed).pipe(Effect.ignore)));
    await Bun.sleep(1000);
  }

  throw new Error("Verification transaction did not settle in 60 seconds");
};

const createWithShortRecovery = pairedCreation({
  sponsor,
  server,
  run,
  opening,
  approvedBy,
  walletRow,
  waitApplied,
  remember,
});

assert.equal((await server.getNetwork()).passphrase, networkPassphrase);

await Promise.all(
  [sponsor, feePayer, outsider, exchangeKey].map((key) =>
    fundWithFriendbot(key.publicKey()),
  ),
);

console.log("Friendbot funded fresh, separate reserve sponsor and fee payer.");

const requireMemo = new TransactionBuilder(
  await horizon.loadAccount(exchange),
  { fee: baseFee, networkPassphrase },
)
  .addOperation(
    Operation.manageData({ name: memoRequiredDataName, value: "1" }),
  )
  .setTimeout(120)
  .build();

requireMemo.sign(exchangeKey);

await horizon.submitTransaction(requireMemo);

const outsiderClaim = new WalletClaim({
  address: addressOf(outsider),
  username: Schema.decodeSync(Username)(`vo_${runId}`),
});

assert.ok((await opening(outsiderClaim)) instanceof NotSponsored);

assert.ok(
  Option.isNone(
    await run(
      Directory.use((directory) => directory.byAddress(outsiderClaim.address)),
    ),
  ),
);

console.log(
  "PASS sponsorship gate rejects a fresh Friendbot account before claiming its username.",
);

const racer = Keypair.random();

const racerClaim = new WalletClaim({
  address: addressOf(racer),
  username: Schema.decodeSync(Username)(recoveryName),
});

const racerDraft = await opening(racerClaim);

assert.ok(racerDraft instanceof OpeningDraft);

const first = await createWithShortRecovery(user, recoveryName);

assert.ok(
  (await opening(racerClaim, approvedBy(racer, racerDraft))) instanceof
    UsernameTaken,
);

assert.ok(
  Option.isNone(
    await run(Chain.use((chain) => chain.account(racerClaim.address))),
  ),
);

console.log(
  "PASS name race loser refused before submission; its account was never created.",
);

const early = await server.sendTransaction(
  TransactionBuilder.fromXDR(first.sealed.envelope, networkPassphrase),
);

const outerResult = early.errorResult?.result;

const earlyCode =
  outerResult?.type === "txFeeBumpInnerFailed"
    ? outerResult.innerResultPair.result.result.type
    : outerResult?.type;

assert.equal(earlyCode, "txTooEarly");

console.log(
  "Stored recovery was unsubmitted; early probe rejected txTooEarly.",
);

while (Number((await server.getLatestLedger()).closeTime) < first.minTime)
  await Bun.sleep(1000);

const atTimeBound = await server.getLatestLedger();

assert.ok(
  atTimeBound.sequence + 1 < first.minLedger,
  "The recovery time bound must pass before its ledger bound for this probe",
);

const ledgerEarly = await server.sendTransaction(
  TransactionBuilder.fromXDR(first.sealed.envelope, networkPassphrase),
);

const ledgerEarlyResult = ledgerEarly.errorResult?.result;

assert.equal(
  ledgerEarlyResult?.type === "txFeeBumpInnerFailed"
    ? ledgerEarlyResult.innerResultPair.result.result.type
    : ledgerEarlyResult?.type,
  "txTooEarly",
);

console.log(
  "PASS recovery past its time bound is still txTooEarly below ledger N+1, so ACCOUNT_MERGE_SEQNUM_TOO_FAR cannot burn its signature.",
);

while ((await server.getLatestLedger()).sequence < first.minLedger)
  await Bun.sleep(1000);

await run(Wallet.use((wallet) => wallet.sweep));

await waitApplied(first.sealed);

await run(Wallet.use((wallet) => wallet.sweep));

remember("bounded recovery", first.sealed.hash);

assert.equal((await walletRow(first.claim.address)).status, "recovered");

assert.ok(
  (await run(
    Wallet.use((wallet) => wallet.overview(first.claim.address)),
  )) instanceof NeedsReopening,
);

const reopened = await opening(first.claim);

assert.ok(reopened instanceof OpeningDraft);

assert.ok(reopened.recovery !== undefined);

await opening(first.claim, approvedBy(user, reopened));

const reopenedHash = (await walletRow(first.claim.address)).attemptHash;

assert.ok(reopenedHash);

assert.ok((await untilOpened(first.claim)) instanceof Opened);

remember("same-key same-username reopening", reopenedHash);

const repairSource = await server.getAccount(first.claim.address);

const removeTrust = new TransactionBuilder(repairSource, {
  fee: baseFee,
  networkPassphrase,
})
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
  hash: hexHash(removeOuter),
  expiresAt: DateTime.makeUnsafe(Date.now() + 120000),
});

await waitApplied(removal);

remember("external trustline removal", removal.hash);

assert.ok(
  (await run(
    Wallet.use((wallet) => wallet.overview(first.claim.address)),
  )) instanceof NeedsReopening,
);

const repair = await opening(first.claim);

assert.ok(repair instanceof OpeningDraft);

const repairFacts = Option.getOrThrow(readEnvelope(repair.request.envelope));

assert.ok(repairFacts instanceof OpeningFacts);

assert.equal(repairFacts.createAccount, false);

assert.ok(repairFacts.window !== undefined);

assert.ok(repair.recovery !== undefined);

await opening(first.claim, approvedBy(user, repair));

const repairHash = (await walletRow(first.claim.address)).attemptHash;

assert.ok(repairHash);

assert.ok((await untilOpened(first.claim)) instanceof Opened);

remember("sponsored trustline-only repair", repairHash);

const second = await createWithShortRecovery(activityUser, `va_${runId}`);

const holder = await server.getAccount(second.claim.address);

const bump = new TransactionBuilder(holder, { fee: baseFee, networkPassphrase })
  .addOperation(
    Operation.bumpSequence({
      bumpTo: (BigInt(holder.sequenceNumber()) + 1n).toString(),
    }),
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
  hash: hexHash(feeBump),
  expiresAt: DateTime.makeUnsafe(Date.now() + 120000),
});

const alternate = TransactionBuilder.buildFeeBumpTransaction(
  sponsor.publicKey(),
  baseFee,
  bump,
  networkPassphrase,
);

alternate.sign(sponsor);

const replacement = new Sealed({
  envelope: alternate.toXDR(),
  hash: hexHash(alternate),
  expiresAt: activity.expiresAt,
});

await waitApplied(replacement);

remember("device activity under alternate fee payer", replacement.hash);

assert.equal(
  (await server.getTransaction(activity.hash)).status,
  rpc.Api.GetTransactionStatus.NOT_FOUND,
);

assert.ok(
  (await run(Chain.use((chain) => chain.settlement(activity)))) instanceof
    Applied,
);

console.log(
  "PASS settlement resolves the original intent through its included inner hash under an alternate fee payer.",
);

let consumed = await run(Chain.use((chain) => chain.settlement(second.sealed)));

for (
  let attempt = 0;
  attempt < 30 && !(consumed instanceof Rejected);
  attempt++
) {
  await Bun.sleep(1000);
  consumed = await run(Chain.use((chain) => chain.settlement(second.sealed)));
}

assert.ok(consumed instanceof Rejected);

assert.equal(consumed.code, "sequence_consumed");

console.log(
  "PASS absent recovery reaches sequence_consumed after a different transaction consumes its sequence.",
);

while (Number((await server.getLatestLedger()).closeTime) < second.minTime)
  await Bun.sleep(1000);

await run(Wallet.use((wallet) => wallet.sweep));

assert.equal(
  (await server.getTransaction(second.sealed.hash)).status,
  rpc.Api.GetTransactionStatus.NOT_FOUND,
);

assert.equal((await walletRow(second.claim.address)).status, "active");

console.log("Sweep skipped recovery after the device advanced its sequence.");

const toExchange = (
  memo?: PaymentMemo,
  destination: DestinationAddress = exchange,
) =>
  new TransferOrder({
    id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
    from: second.claim.address,
    to: AddressRecipient.make({ value: destination }),
    asset: NativeAsset.make({}),
    amount: Schema.decodeSync(PositiveAmount)("10000000"),
    memo,
  });

const transfer = (
  order: TransferOrder,
  approval: Option.Option<Approval> = Option.none(),
) => run(Wallet.use((wallet) => wallet.transfer(order, approval)));

const untilSettled = async (order: TransferOrder) => {
  let receipt = await transfer(order);

  for (
    let attempt = 0;
    attempt < 60 && !(receipt instanceof Settled);
    attempt++
  ) {
    await Bun.sleep(1000);
    receipt = await transfer(order);
  }

  return receipt;
};

assert.deepEqual(
  await transfer(toExchange()),
  new ExternalMemoRequired({
    address: exchange,
    exchange: "Exchange",
    source: "https://stellar.org/protocol/sep-29",
  }),
);

console.log(
  "PASS a payment without a memo to the test exchange returns ExternalMemoRequired from its config.memo_required entry.",
);

const topUp = new TransactionBuilder(
  await server.getAccount(sponsor.publicKey()),
  { fee: baseFee, networkPassphrase },
)
  .addOperation(
    Operation.payment({
      destination: second.claim.address,
      asset: Asset.native(),
      amount: "5",
    }),
  )
  .setTimeout(120)
  .build();

topUp.sign(sponsor);

const topUpSent = await server.sendTransaction(topUp);

assert.equal(topUpSent.status, "PENDING");

assert.equal(
  (await server.pollTransaction(topUpSent.hash, { attempts: 60 })).status,
  rpc.Api.GetTransactionStatus.SUCCESS,
);

const memoOrder = toExchange(
  Schema.decodeSync(PaymentMemo)({ type: "text", value: "orchid-sep29" }),
);

const memoDraft = await transfer(memoOrder);

assert.ok(memoDraft instanceof TransferDraft);

assert.equal(memoDraft.memoRequired, true);

await transfer(memoOrder, approve(memoDraft.request, activityUser));

const memoTransfer = Option.getOrThrow(
  await run(Transfers.use((store) => store.find(memoOrder.id))),
);

assert.ok(memoTransfer instanceof Authorized);

const memoReceipt = await untilSettled(memoOrder);

assert.ok(memoReceipt instanceof Settled);

assert.deepEqual(memoReceipt.memo, memoOrder.memo);

remember("memo payment to the test exchange", memoTransfer.sealed.hash);

console.log(
  "PASS a payment with a memo to the test exchange drafts with memoRequired and settles.",
);

const muxedExchange = Schema.decodeSync(MuxedAddress)(
  new MuxedAccount(new Account(exchange, "0"), "1234567890").accountId(),
);

assert.deepEqual(
  await transfer(
    toExchange(
      Schema.decodeSync(PaymentMemo)({ type: "text", value: "orchid-muxed" }),
      muxedExchange,
    ),
  ),
  new MemoNotAllowed({ reason: "muxed" }),
);

const muxedOrder = toExchange(undefined, muxedExchange);

const muxedDraft = await transfer(muxedOrder);

assert.ok(muxedDraft instanceof TransferDraft);

assert.equal(muxedDraft.memoRequired, false);

await transfer(muxedOrder, approve(muxedDraft.request, activityUser));

const muxedTransfer = Option.getOrThrow(
  await run(Transfers.use((store) => store.find(muxedOrder.id))),
);

assert.ok(muxedTransfer instanceof Authorized);

const muxedReceipt = await untilSettled(muxedOrder);

assert.ok(muxedReceipt instanceof Settled);

remember("muxed payment to the test exchange", muxedTransfer.sealed.hash);

const [muxedPayment] = (
  await horizon.payments().forTransaction(muxedTransfer.sealed.hash).call()
).records;

assert.ok(muxedPayment && muxedPayment.type === "payment");

assert.equal(muxedPayment.to, exchange);

assert.equal(muxedPayment.to_muxed, muxedExchange);

assert.equal(
  (await horizon.transactions().transaction(muxedTransfer.sealed.hash).call())
    .memo_type,
  "none",
);

console.log(
  "PASS a muxed payment to the test exchange settles to the muxed destination without a memo, and a memo is refused with MemoNotAllowed.",
);

const depositor = Keypair.random();

await fundWithFriendbot(depositor.publicKey());

await fundWithUsdc(depositor.publicKey(), "10");

const depositPayment = new TransactionBuilder(
  await horizon.loadAccount(depositor.publicKey()),
  { fee: baseFee, networkPassphrase },
)
  .addOperation(
    Operation.payment({
      destination: second.claim.address,
      asset: usdc,
      amount: "5",
    }),
  )
  .setTimeout(120)
  .build();

depositPayment.sign(depositor);

const depositSubmitted = await horizon.submitTransaction(depositPayment);

remember("USDC deposit from a plain account", depositSubmitted.hash);

const listedDeposits = async () => {
  await run(Wallet.use((wallet) => wallet.ingestDeposits));

  const page = await run(
    Wallet.use((wallet) => wallet.activity(second.claim.address)),
  );

  return page instanceof ActivityPage
    ? page.entries.filter((entry) => entry instanceof DepositActivity)
    : [];
};

let deposits = await listedDeposits();

for (let attempt = 0; attempt < 30 && deposits.length === 0; attempt++) {
  await Bun.sleep(2000);
  deposits = await listedDeposits();
}

assert.equal(deposits.length, 1);

assert.equal(deposits[0]?.from.address, addressOf(depositor));

assert.equal(deposits[0]?.amount, 50000000n);

console.log(
  "PASS a USDC payment from a plain account is ingested from RPC events and listed as one deposit.",
);

const result = {
  verifiedAt: new Date().toISOString(),
  network: "testnet",
  reserveSponsor: sponsor.publicKey(),
  feePayer: feePayer.publicKey(),
  hashes,
  checks: [
    "raw getLedgerEntries extXdr identifies configured sponsor on account and trustline",
    "unsponsored Friendbot account refused before username claim",
    "username bound with the signed opening; race loser refused before submission",
    "0 XLM sponsored opening + USDC trustline",
    "paired opening signs its recovery with the opening and stores it unsubmitted",
    "CAP-21 pinned opening settles with the created account at sequence N<<32",
    "paired recovery stays txTooEarly below ledger N+1 even past its time bound",
    "recovery txTooEarly before minTime",
    "pre-signed paired recovery settles once the ledger passes N",
    "recovered state",
    "same-key same-username reopening",
    "sponsored trustline-only repair",
    "sweep skips changed sequence",
    "settlement discovers inner inclusion under alternate fee payer while original outer is NOT_FOUND",
    "consumed sequence plus complete inner absence evidence concludes sequence_consumed",
    "config.memo_required = 1 refuses a memoless payment with SEP-29 evidence",
    "memo payment to a config.memo_required account drafts with memoRequired and settles",
    "muxed payment to a config.memo_required account settles to the muxed destination with no memo; a memo with a muxed recipient is refused with MemoNotAllowed",
    "USDC payment from a plain account is read from getEvents and listed as one deposit",
  ],
  deferred: [
    "Live USDC payment and nonzero-USDC recovery guard require Circle testnet USDC funding; covered by local behavioral tests.",
  ],
};

console.log(JSON.stringify(result, null, 2));

console.log("PASS live testnet verification; public evidence printed above.");
