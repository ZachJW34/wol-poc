import { expect, test } from "@playwright/test";
import { fixtureDevices, startScenarioServer } from "./harness";

test("device list renders the served devices", async ({ page }) => {
  const server = await startScenarioServer("empty");
  try {
    await page.goto(`${server.url}/`);

    const status = page.getByRole("status");
    await expect(status).toContainText("No devices yet");
  } finally {
    await server.stop();
  }
});

test("device names render as text, not as HTML", async ({ page }) => {
  const server = await startScenarioServer("fixture");
  try {
    await page.goto(`${server.url}/`);

    const status = page.getByRole("status");
    const name = fixtureDevices[0]!.name;
    await expect(status).toContainText(name);

    // The markup must appear as literal text: no element created from the name
    // exists inside the status region, so nothing in it can execute.
    await expect(status.locator("script")).toHaveCount(0);
    // P07 device cards add MAC, broadcast, sent time, and controls inside the
    // list item, so the exact-text assertion targets the name element itself.
    await expect(status.locator("li .device-name")).toHaveText(name);
  } finally {
    await server.stop();
  }
});
