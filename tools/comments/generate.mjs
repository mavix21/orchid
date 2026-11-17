import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { removeComments } from "./strip.mjs";

const [filename, ...command] = process.argv.slice(2);
const result = spawnSync("bun", ["run", ...command], { stdio: "inherit" });
const source = await readFile(filename, "utf8");

await writeFile(filename, removeComments(filename, source));

const formatted = spawnSync("bun", ["x", "oxfmt", filename], {
  stdio: "inherit",
});

if (result.error) throw result.error;

if (formatted.error) throw formatted.error;

process.exitCode = (result.status ?? 1) || (formatted.status ?? 1);
