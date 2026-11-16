// Run: cd spikes/testnet-sponsored-flow && bun install --frozen-lockfile && bun index.ts
// Throwaway TESTNET ONLY. No seeds, mnemonics, or secret keys are logged or saved.
// Official sources:
// https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves
// https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions
// https://stellar.github.io/js-stellar-sdk/
// https://github.com/stellar/friendbot#api-usage
// https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
// https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
// https://github.com/satoshilabs/slips/blob/master/slip-0010.md
// https://nodejs.org/api/crypto.html
// https://developers.circle.com/stablecoins/usdc-contract-addresses#testnet
// https://faucet.circle.com/ (Stellar Testnet; public faucet requires reCAPTCHA)
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const server = new Horizon.Server("https://horizon-testnet.stellar.org");
const usdc = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const explorer = "https://stellar.expert/explorer/testnet";

async function fetchText(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const body = await response.text();

  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${body}`);

  return body;
}

// Direct BIP-39 / SLIP-0010 implementation; checked against SEP-0005 test 5 below.
function derivePrimaryKey(mnemonic: string) {
  const seed = pbkdf2Sync(mnemonic.normalize("NFKD"), "mnemonic", 2048, 64, "sha512");
  let node = createHmac("sha512", "ed25519 seed").update(seed).digest();

  for (const index of [44, 148, 0]) {
    const child = Buffer.alloc(37);
    child[0] = 0;
    node.copy(child, 1, 0, 32);
    child.writeUInt32BE(index + 0x80000000, 33);
    node = createHmac("sha512", node.subarray(32)).update(child).digest();
  }

  return Keypair.fromRawEd25519Seed(node.subarray(0, 32));
}

async function generateUser() {
  const text = await fetchText(
    "https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt",
  );

  const words = text.trim().split("\n");
  assert.equal(words.length, 2048);
  assert.equal(new Set(words).size, 2048);
  const entropy = randomBytes(16);
  const checksum = createHash("sha256").update(entropy).digest();

  const bits =
    [...entropy].map((byte) => byte.toString(2).padStart(8, "0")).join("") +
    checksum[0].toString(2).padStart(8, "0").slice(0, 4);

  const mnemonic = Array.from(
    { length: 12 },
    (_, index) => words[Number.parseInt(bits.slice(index * 11, (index + 1) * 11), 2)],
  ).join(" ");

  assert.equal(mnemonic.split(" ").length, 12);
  console.log(
    "Generated fresh 128-bit / 12-word SEP-0005 mnemonic; path m/44'/148'/0' (phrase withheld).",
  );

  return derivePrimaryKey(mnemonic);
}

function printTransaction(label: string, hash: string) {
  console.log(`${label}: ${hash}\n${explorer}/tx/${hash}`);
}

async function printAccount(label: string, key: Keypair, baseReserve: number) {
  const account = await server.loadAccount(key.publicKey());
  console.log(
    JSON.stringify(
      {
        label,
        address: account.id,
        link: `${explorer}/account/${account.id}`,
        balances: account.balances,
        subentries: account.subentry_count,
        numSponsoring: account.num_sponsoring,
        numSponsored: account.num_sponsored,
        sponsor: account.sponsor ?? null,
        baseReserveXlm: baseReserve / 10_000_000,
        minimumBalanceXlm:
          ((2 + account.subentry_count + account.num_sponsoring - account.num_sponsored) *
            baseReserve) /
          10_000_000,
      },
      null,
      2,
    ),
  );

  return account;
}

async function main() {
  const vector = derivePrimaryKey(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  );

  assert.equal(vector.publicKey(), "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX");
  assert.equal(vector.secret(), "SBUV3MRWKNS6AYKZ6E6MOUVF2OYMON3MIUASWL3JLY5E3ISDJFELYBRZ");
  console.log("SEP-0005 test 5: primary public and secret keys match.");

  const sponsor = Keypair.random();
  console.log(`Sponsor: ${sponsor.publicKey()}`);
  await fetchText(`https://friendbot.stellar.org/?addr=${sponsor.publicKey()}`);

  const funding = await server
    .transactions()
    .forAccount(sponsor.publicKey())
    .order("desc")
    .limit(1)
    .call();

  assert.equal(funding.records.length, 1);
  printTransaction("Friendbot", funding.records[0].hash);

  const user = await generateUser();
  console.log(`User: ${user.publicKey()}`);
  const source = await server.loadAccount(sponsor.publicKey());
  const baseFee = await server.fetchBaseFee();

  // The sponsor is the transaction source: the new user has no sequence number yet.
  const inner = new TransactionBuilder(source, {
    fee: String(baseFee),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        source: sponsor.publicKey(),
        sponsoredId: user.publicKey(),
      }),
    )
    .addOperation(
      Operation.createAccount({
        source: sponsor.publicKey(),
        destination: user.publicKey(),
        startingBalance: "0",
      }),
    )
    .addOperation(Operation.changeTrust({ source: user.publicKey(), asset: usdc }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: user.publicKey() }))
    .setTimeout(180)
    .build();

  inner.sign(user);
  // Required for beginSponsoringFutureReserves, createAccount, and the transaction source.
  inner.sign(sponsor);

  const outer = TransactionBuilder.buildFeeBumpTransaction(
    sponsor.publicKey(),
    String(baseFee),
    inner,
    Networks.TESTNET,
  );

  outer.sign(sponsor);
  printTransaction("Opening inner", Buffer.from(inner.hash()).toString("hex"));
  printTransaction("Opening fee bump", Buffer.from(outer.hash()).toString("hex"));
  const result = await server.submitTransaction(outer);
  assert.equal(result.successful, true);
  printTransaction("Confirmed opening", result.hash);
  console.log(`Opening ledger: ${result.ledger}`);

  const ledgers = await server.ledgers().order("desc").limit(1).call();
  const baseReserve = ledgers.records[0].base_reserve_in_stroops;
  const sponsorAccount = await printAccount("sponsor", sponsor, baseReserve);
  const userAccount = await printAccount("user", user, baseReserve);
  assert.equal(sponsorAccount.num_sponsoring, 3);
  assert.equal(userAccount.num_sponsored, 3);
  assert.equal(userAccount.sponsor, sponsor.publicKey());
  assert.equal(
    userAccount.balances.find((balance) => balance.asset_type === "native")?.balance,
    "0.0000000",
  );

  const trustline = userAccount.balances.find(
    (balance) =>
      balance.asset_type === "credit_alphanum4" &&
      balance.asset_code === usdc.code &&
      balance.asset_issuer === usdc.issuer,
  );

  assert.ok(trustline);
  assert.equal(trustline.asset_type, "credit_alphanum4");
  assert.ok(trustline.asset_type === "credit_alphanum4");
  assert.equal(trustline.sponsor, sponsor.publicKey());
  assert.equal(trustline.balance, "0.0000000");
  console.log(
    "PASS: account + USDC trustline in ONE sponsorship sandwich; user owns exactly 0 XLM.",
  );
  console.log(
    "BLOCKED before step 5: no documented official programmatic faucet for this independently generated Stellar G account was found.",
  );
  console.log(
    `Owner action: select USDC / Stellar Testnet at https://faucet.circle.com/ and request 20 USDC for ${user.publicKey()} (reCAPTCHA).`,
  );
  console.log(
    "USDC issuer source: https://developers.circle.com/stablecoins/usdc-contract-addresses#testnet",
  );
  console.log(
    "USDC transfer, second sponsored account, and payment with 0 XLM remain UNVERIFIED. No recipient was created.",
  );
  console.log(
    "Keys are ephemeral: this run cannot resume after exit. A later payment proof needs a retained testnet signer and manual funding during that run, or an official supported programmatic funding source.",
  );
  process.exitCode = 2;
}

await main();
