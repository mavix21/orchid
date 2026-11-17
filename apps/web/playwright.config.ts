import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:4173",
    ...devices["Pixel 7"],
  },
  webServer: {
    command: "bun run build && bun run preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
