import { spawnSync } from "node:child_process";

for (const probe of ["server", "relative", "private"]) {
  const result = spawnSync("bun", ["run", "--cwd", "apps/web", "build"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, ORCHID_WALLET_BOUNDARY_PROBE: probe },
    encoding: "utf8",
  });

  const output = result.stdout + result.stderr;

  const expected =
    probe === "private"
      ? /Missing.*specifier|not exported|not defined by.*exports/i
      : /\[import-protection\] Import denied in client environment/;

  if (result.status === 0 || !expected.test(output)) {
    process.stderr.write(output);
    throw new Error(`Wallet boundary probe ${probe} did not fail for the expected reason`);
  }

  process.stdout.write(`Wallet boundary ${probe}: rejected by real Vite build\n`);
}
