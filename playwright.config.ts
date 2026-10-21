import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 7323);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",

  // The fixture is the real handler with a harmless injected wake runner.
  // It serves the built UI, so the build runs first and the tests are self-sufficient.
  webServer: {
    command: "bun run build && bun tests/fixtures/e2e-server.ts",
    env: { E2E_PORT: String(port), NODE_ENV: "test" },
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },

  use: {
    baseURL,
    trace: "on-first-retry",
  },

  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "phone-360",
      use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 720 } },
    },
  ],
});
