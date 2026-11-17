import { Keypair } from "@stellar/stellar-sdk";
import { existsSync, writeFileSync } from "node:fs";

const file = `${import.meta.dir}/../.dev.vars`;

if (existsSync(file))
  throw new Error(
    "A .dev.vars file already exists; refusing to replace secrets",
  );

const sponsor = Keypair.random();
const feePayer = Keypair.random();
const settings = `RESERVE_SPONSOR_SECRET=${sponsor.secret()}\nFEE_PAYER_SECRET=${feePayer.secret()}\n`;

writeFileSync(
  file,
  `${settings}VERIFY_USER_SECRET=${Keypair.random().secret()}\nVERIFY_ACTIVITY_SECRET=${Keypair.random().secret()}\nVERIFY_RECIPIENT_SECRET=${Keypair.random().secret()}\n`,
  { mode: 0o600, flag: "wx" },
);

console.log(
  "Fresh testnet keys saved only in the gitignored wallet .dev.vars file (0600).",
);
