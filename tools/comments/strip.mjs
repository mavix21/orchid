import { readFile, writeFile } from "node:fs/promises";
import { parseSync } from "oxc-parser";

export function removeComments(filename, source) {
  const parsed = parseSync(filename, source);

  if (parsed.errors.length > 0) {
    throw new Error(`Cannot parse ${filename}: ${parsed.errors[0].message}`);
  }

  let result = source;

  for (const comment of parsed.comments.toReversed()) {
    if (
      source.startsWith("#!", comment.start) ||
      comment.value.trim() === "eslint-disable" ||
      comment.value.trim() === "@ts-nocheck"
    )
      continue;

    result =
      result.slice(0, comment.start) +
      result.slice(comment.start, comment.end).replace(/[^\r\n]/g, " ") +
      result.slice(comment.end);
  }

  return result
    .replace(/^[\t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}

if (import.meta.main) {
  for (const filename of process.argv.slice(2)) {
    const source = await readFile(filename, "utf8");

    await writeFile(filename, removeComments(filename, source));
  }
}
