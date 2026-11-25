import { Keypair } from "@stellar/stellar-sdk";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fundWithFriendbot } from "@workspace/wallet/testnet";

const humanCheckTestKeys: Pick<
  NodeJS.ProcessEnv,
  "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY"
> = {
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
};

const developerSecrets = fileURLToPath(
  new URL("../.dev.vars", import.meta.url),
);

const fundedTestnetSecrets = async () => {
  const reserveSponsor = Keypair.random();
  const feePayer = Keypair.random();

  await fundWithFriendbot(reserveSponsor.publicKey());
  await fundWithFriendbot(feePayer.publicKey());

  return {
    RESERVE_SPONSOR_SECRET: reserveSponsor.secret(),
    FEE_PAYER_SECRET: feePayer.secret(),
  };
};

const previewSecrets = async () =>
  existsSync(developerSecrets) ? {} : fundedTestnetSecrets();

const runScript = (script: string[], env: NodeJS.ProcessEnv) =>
  new Promise<number>((resolve, reject) => {
    spawn(process.execPath, ["run", ...script], { stdio: "inherit", env })
      .on("error", reject)
      .on("exit", (code) => resolve(code ?? 1));
  });

const [secrets, buildExitCode] = await Promise.all([
  previewSecrets(),
  runScript(["build"], process.env),
]);

if (buildExitCode !== 0) process.exit(buildExitCode);

process.exit(
  await runScript(["preview", "--port", "4173", "--strictPort"], {
    ...process.env,
    ...secrets,
    ...humanCheckTestKeys,
  }),
);
