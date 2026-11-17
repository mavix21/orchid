import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every integration suite truncates the same disposable database.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
