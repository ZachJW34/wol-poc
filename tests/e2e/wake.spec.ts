import { expect, test, type Page } from "@playwright/test";
import { startScenarioServer, tempDatabasePath } from "./harness";

/**
 * P07 wake flows against the accepted API: the real Bun app and the real C3
 * wake service, with only the command runner replaced by the harness fake.
 * Nothing here claims a real packet was sent; the assertions check the served
 * feedback and the persisted record.
 */
type ApiDevice = {
  name: string;
  macAddress: string;
  broadcastAddress: string | null;
  lastWakeSentAt: string | null;
};

/**
 * Query the scenario subprocess directly. The Playwright `baseURL` points at the
 * shared webServer, so the API check must use the spawned scenario's own origin;
 * the UI itself keeps fetching relative `/api` paths (C4).
 */
async function apiDevices(page: Page, origin: string): Promise<ApiDevice[]> {
  const response = await page.request.get(`${origin}/api/devices`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.devices as ApiDevice[];
}

async function addDevice(page: Page, name: string, mac: string): Promise<void> {
  const form = page.locator("form.add-form");
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("MAC address").fill(mac);
  await form.getByRole("button", { name: "Add device" }).click();
  await expect(page.getByRole("status")).toContainText("Device added");
}

const cardOf = (page: Page) => page.getByRole("status").locator(".device-card");

test("wake shows pending, then the exact success label and a refreshed timestamp", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
    E2E_RUNNER: "ok-after-delay",
    E2E_RUNNER_DELAY_MS: "1500",
  });
  try {
    await page.goto(`${server.url}/`);
    await addDevice(page, "Wake PC", "02:AA:BB:CC:DD:EE");

    const card = cardOf(page);
    const wake = card.getByRole("button", { name: "Wake Wake PC" });
    await wake.click();

    // Pending: the fake command is still in flight, so the control stays disabled.
    await expect(wake).toBeDisabled();
    await expect(wake).toHaveText("Waking…");

    await expect(page.getByRole("status")).toContainText("Wake packet sent");
    await expect(wake).toBeEnabled();

    const saved = await apiDevices(page, server.url);
    expect(saved[0]!.lastWakeSentAt).not.toBeNull();
    await expect(card.locator("time")).toHaveAttribute(
      "datetime",
      saved[0]!.lastWakeSentAt!,
    );
  } finally {
    await server.stop();
  }
});

test("edit and delete are disabled while this browser is waking that device", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
    E2E_RUNNER: "ok-after-delay",
    E2E_RUNNER_DELAY_MS: "1500",
  });
  try {
    await page.goto(`${server.url}/`);
    await addDevice(page, "Locked PC", "02:AA:BB:CC:DD:EE");

    const card = cardOf(page);
    await card.getByRole("button", { name: "Wake Locked PC" }).click();
    await expect(
      card.getByRole("button", { name: "Edit Locked PC" }),
    ).toBeDisabled();
    await expect(
      card.getByRole("button", { name: "Delete Locked PC" }),
    ).toBeDisabled();

    await expect(page.getByRole("status")).toContainText("Wake packet sent");
    await expect(
      card.getByRole("button", { name: "Edit Locked PC" }),
    ).toBeEnabled();
  } finally {
    await server.stop();
  }
});

test("a failed command shows safe feedback and does not advance the sent time", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
    E2E_RUNNER: "failed",
  });
  try {
    await page.goto(`${server.url}/`);
    await addDevice(page, "Failing PC", "02:AA:BB:CC:DD:EE");

    await cardOf(page).getByRole("button", { name: "Wake Failing PC" }).click();
    await expect(page.getByRole("status")).toContainText(
      "The wake command failed.",
    );

    const saved = await apiDevices(page, server.url);
    expect(saved[0]!.lastWakeSentAt).toBeNull();
    await expect(cardOf(page)).toContainText("Last sent: Never sent");
  } finally {
    await server.stop();
  }
});

test("a timed-out command shows safe feedback and does not advance the sent time", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
    E2E_RUNNER: "timeout",
  });
  try {
    await page.goto(`${server.url}/`);
    await addDevice(page, "Timeout PC", "02:AA:BB:CC:DD:EE");

    await cardOf(page).getByRole("button", { name: "Wake Timeout PC" }).click();
    await expect(page.getByRole("status")).toContainText(
      "The wake command timed out.",
    );

    const saved = await apiDevices(page, server.url);
    expect(saved[0]!.lastWakeSentAt).toBeNull();
  } finally {
    await server.stop();
  }
});

test("a 429 honors the returned retryAfterMs before re-enabling the wake", async ({
  browser,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
    E2E_RUNNER: "ok-after-delay",
    E2E_RUNNER_DELAY_MS: "2000",
  });
  try {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await pageA.goto(`${server.url}/`);
    await addDevice(pageA, "Shared PC", "02:AA:BB:CC:DD:EE");

    const pageB = await context.newPage();
    await pageB.goto(`${server.url}/`);
    const statusB = pageB.getByRole("status");
    const cardB = cardOf(pageB);
    await expect(cardB).toContainText("Shared PC");

    const wakeA = cardOf(pageA).getByRole("button", { name: "Wake Shared PC" });
    const wakeB = cardB.getByRole("button", { name: "Wake Shared PC" });

    // Page A holds the in-flight slot for 2s, so page B's request gets the real
    // service's in-flight WAKE_COOLDOWN with the full 5000ms retryAfterMs.
    await wakeA.click();
    await expect(wakeA).toBeDisabled();
    const firstDeniedAt = Date.now();
    await wakeB.click();

    await expect(statusB).toContainText(
      "Wake failed: A wake is already running for this device.",
    );
    await expect(wakeB).toBeDisabled();
    await expect(cardB).toContainText("Cooldown: try again in");

    // The device is preserved for both clients.
    const saved = await apiDevices(pageB, server.url);
    expect(saved).toHaveLength(1);

    // The UI must honor the returned delay rather than re-enabling early: still
    // disabled shortly after the denial, then enabled about 5s after that request.
    await pageB.waitForTimeout(1000);
    await expect(wakeB).toBeDisabled();
    await expect(wakeB).toBeEnabled({ timeout: 10_000 });
    expect(Date.now() - firstDeniedAt).toBeGreaterThanOrEqual(4500);

    // The service cooldown began when page A's command completed, so the next
    // request is still denied with the remaining window (~2s), not accepted.
    const secondDeniedAt = Date.now();
    await wakeB.click();
    await expect(statusB).toContainText(
      "Wake failed: Wake cooldown is active for this device.",
    );
    await expect(wakeB).toBeDisabled();
    await pageB.waitForTimeout(1000);
    await expect(wakeB).toBeDisabled();
    await expect(wakeB).toBeEnabled({ timeout: 10_000 });
    expect(Date.now() - secondDeniedAt).toBeGreaterThanOrEqual(1500);

    // Once the service cooldown has passed, the server accepts the wake.
    await wakeB.click();
    await expect(statusB).toContainText("Wake packet sent");
    const after = await apiDevices(pageB, server.url);
    expect(after[0]!.lastWakeSentAt).not.toBeNull();

    await context.close();
  } finally {
    await server.stop();
  }
});
