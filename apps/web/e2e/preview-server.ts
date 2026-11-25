import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fundedTestnetKeypair, openChannels } from "@workspace/wallet/testnet";

const humanCheckTestKeys: Record<
  "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY",
  string
> = {
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
};

const developerSecrets = fileURLToPath(
  new URL("../.dev.vars", import.meta.url),
);

const fundedTestnetSecrets = async () => {
  const reserveSponsor = await fundedTestnetKeypair();
  const feePayer = await fundedTestnetKeypair();

  await openChannels(reserveSponsor.secret(), feePayer.secret());

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
  await runScript(
    ["preview", "--port", "4173", "--strictPort"],
    Object.assign({}, process.env, secrets, humanCheckTestKeys, {
      SESSION_SECRET: randomBytes(32).toString("base64url"),
    }),
  ),
);
