import {
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { existsSync, writeFileSync } from "node:fs";
import { memoRequiredDataName } from "../src/server/exchange-memos.server";
import { baseFee, networkPassphrase } from "../src/stellar/network";

const file = `${import.meta.dir}/../.dev.vars`;

if (existsSync(file))
  throw new Error(
    "A .dev.vars file already exists; refusing to replace secrets",
  );

const server = new rpc.Server("https://soroban-testnet.stellar.org");

if ((await server.getNetwork()).passphrase !== networkPassphrase)
  throw new Error("The RPC server is not on Stellar testnet");

const sponsor = Keypair.random();
const feePayer = Keypair.random();
const exchange = Keypair.random();

const funding = await fetch(
  `https://friendbot.stellar.org/?addr=${exchange.publicKey()}`,
);

if (!funding.ok)
  throw new Error(`Friendbot funding failed with HTTP ${funding.status}`);

const visibleExchange = async (attemptsLeft: number) => {
  try {
    return await server.getAccount(exchange.publicKey());
  } catch (error) {
    if (attemptsLeft <= 1)
      throw new Error("The funded test exchange never appeared on RPC", {
        cause: error,
      });

    await Bun.sleep(1000);

    return visibleExchange(attemptsLeft - 1);
  }
};

const requireMemo = new TransactionBuilder(await visibleExchange(30), {
  fee: baseFee,
  networkPassphrase,
})
  .addOperation(
    Operation.manageData({ name: memoRequiredDataName, value: "1" }),
  )
  .setTimeout(120)
  .build();

requireMemo.sign(exchange);

const sent = await server.sendTransaction(requireMemo);

if (sent.status !== "PENDING")
  throw new Error(`The memo requirement was not accepted: ${sent.status}`);

const applied = await server.pollTransaction(sent.hash, { attempts: 60 });

if (applied.status !== rpc.Api.GetTransactionStatus.SUCCESS)
  throw new Error(`The memo requirement did not apply: ${applied.status}`);

const settings = `RESERVE_SPONSOR_SECRET=${sponsor.secret()}\nFEE_PAYER_SECRET=${feePayer.secret()}\n`;

writeFileSync(
  file,
  `${settings}VERIFY_USER_SECRET=${Keypair.random().secret()}\nVERIFY_ACTIVITY_SECRET=${Keypair.random().secret()}\nVERIFY_RECIPIENT_SECRET=${Keypair.random().secret()}\nVERIFY_EXCHANGE_SECRET=${exchange.secret()}\n`,
  { mode: 0o600, flag: "wx" },
);

console.log(
  `Test exchange ${exchange.publicKey()} publishes ${memoRequiredDataName} = "1" (transaction ${sent.hash}).`,
);

console.log(
  "Fresh testnet keys saved only in the gitignored wallet .dev.vars file (0600).",
);
