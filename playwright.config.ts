import { defineConfig } from "@playwright/test";

// P01 baseline harness: a test-only static server (tests/e2e/harness.ts) that
// serves the Vite build. P02 replaces it with the real Bun HTTP application.
const testPort = Number(process.env.E2E_PORT ?? 3123);
const baseURL = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL,
    viewport: { width: 390, height: 640 },
  },
  projects: [
    {
      name: "chromium-mobile",
      use: { browserName: "chromium", viewport: { width: 390, height: 640 } },
    },
  ],
  webServer: {
    command: "bun run build && bun tests/e2e/harness.ts",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
