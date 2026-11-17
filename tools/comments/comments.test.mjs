import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeComments } from "./strip.mjs";

const source = `/** Documentation */
export const url = "https://example.com";
export const marker = "/* literal */";
export const value = 1/* explanation */+2; // trailing
export const element = <div>{/* explanation */}Hello</div>;
`;

test("cleanup preserves literals, token boundaries, and JSX", () => {
  const result = removeComments("fixture.tsx", source);

  expect(result).toContain('"https://example.com"');
  expect(result).toContain('"/* literal */"');
  expect(result).not.toContain("explanation");
  expect(result).not.toContain("Documentation");
  expect(result).toMatch(/1\s+\+2/);
  expect(result).toContain("Hello</div>");
});

test("cleanup refuses malformed source", () => {
  expect(() => removeComments("fixture.ts", "export const = ;")).toThrow();
});

test("Oxlint rejects comments and accepts the cleaned source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchid-comments-"));
  const filename = join(directory, "fixture.tsx");
  const args = ["x", "oxlint", "-c", resolve(".oxlintrc.json"), filename];

  try {
    await writeFile(filename, source);

    const rejected = spawnSync("bun", args, { encoding: "utf8" });

    expect(rejected.status).toBe(1);
    expect(rejected.stdout + rejected.stderr).toContain("orchid(no-comments)");

    await writeFile(filename, removeComments(filename, source));
    execFileSync("bun", args, { stdio: "pipe" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
