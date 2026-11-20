import { Keypair } from "@stellar/stellar-sdk";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fundWithFriendbot } from "./testnet";

const developerSecrets = fileURLToPath(
  new URL("../.dev.vars", import.meta.url),
);

const fundedTestnetSecrets = async () => {
  const reserveSponsor = Keypair.random();
  const feePayer = Keypair.random();

  await Promise.all([
    fundWithFriendbot(reserveSponsor.publicKey()),
    fundWithFriendbot(feePayer.publicKey()),
  ]);

  return {
    RESERVE_SPONSOR_SECRET: reserveSponsor.secret(),
    FEE_PAYER_SECRET: feePayer.secret(),
  };
};

const serve = (env: NodeJS.ProcessEnv) => {
  const server = spawn(
    "bun run build && bun run preview --port 4173 --strictPort",
    { shell: true, stdio: "inherit", env },
  );

  server.on("exit", (code) => process.exit(code ?? 1));
};

if (existsSync(developerSecrets)) serve(process.env);
else serve({ ...process.env, ...(await fundedTestnetSecrets()) });
