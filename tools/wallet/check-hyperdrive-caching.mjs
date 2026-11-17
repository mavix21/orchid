import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

// Wallet reads are plain SELECTs. Hyperdrive caches eligible reads by default, so every
// deployed Hyperdrive configuration must have query caching disabled:
// https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
// This check reads each configuration with `wrangler hyperdrive get <id>`, which prints the
// configuration as JSON, and refuses to continue unless `caching.disabled` is true.

const configPath = resolve(
  process.argv[2] ?? new URL("../../apps/web/wrangler.jsonc", import.meta.url).pathname,
);

const { default: config } = await import(configPath);
const bindings = config.hyperdrive ?? [];

const fail = (message) => {
  process.stderr.write(`Hyperdrive caching check failed: ${message}\n`);
  process.exit(1);
};

if (bindings.length === 0) fail(`no Hyperdrive binding in ${configPath}.`);

for (const { binding, id } of bindings) {
  if (/^0+$/.test(id))
    fail(
      `binding ${binding} still has the placeholder id. Create the Hyperdrive configuration with --caching-disabled and set its id first.`,
    );

  const result = spawnSync("wrangler", ["hyperdrive", "get", id, "--config", configPath], {
    cwd: dirname(configPath),
    encoding: "utf8",
  });

  if (result.status !== 0)
    fail(`wrangler hyperdrive get ${id} exited with ${result.status}.\n${result.stderr}`);

  const start = result.stdout.indexOf("{");

  if (start === -1) fail(`wrangler hyperdrive get ${id} printed no configuration.`);

  const hyperdrive = JSON.parse(result.stdout.slice(start));

  if (hyperdrive.caching?.disabled !== true)
    fail(
      `binding ${binding} (${id}) has query caching enabled. Run: wrangler hyperdrive update ${id} --caching-disabled`,
    );

  process.stdout.write(`Hyperdrive ${binding} (${id}): query caching disabled.\n`);
}
