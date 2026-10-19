import { expect, test } from "@playwright/test";
import { startScenarioServer } from "./harness";

// A fake failing list dependency, served by the real app through the harness
// scenario subprocess. The scenario fails once so retry can show recovery.
test("a load failure is announced and retry recovers", async ({ page }) => {
  const server = await startScenarioServer("fails-then-succeeds");
  try {
    await page.goto(server.url);

    const status = page.getByRole("status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toContainText("Could not load devices");

    const retry = page.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();
    await retry.click();

    await expect(status).toContainText("No devices yet");
  } finally {
    await server.stop();
  }
});
