import { expect, test, type Page } from "@playwright/test";
import { startScenarioServer, tempDatabasePath } from "./harness";

/**
 * P07 mobile management flows against the accepted API: the real Bun app with a
 * real SQLite repository and only the C3 runner replaced by the harness fake.
 * Records are verified through the API, not only through UI feedback.
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

const addForm = (page: Page) => page.locator("form.add-form");

test("add, duplicate validation, edit, clearing the override, and delete", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
  });
  try {
    await page.goto(`${server.url}/`);
    const status = page.getByRole("status");
    await expect(status).toContainText("No devices yet");

    // Add through the UI.
    await addForm(page).getByLabel("Name").fill("Desk PC");
    await addForm(page).getByLabel("MAC address").fill("02:aa:bb:cc:dd:ee");
    await addForm(page).getByLabel("Broadcast override").fill("192.168.1.255");
    await addForm(page).getByRole("button", { name: "Add device" }).click();

    await expect(status).toContainText("Device added");
    const card = status.locator(".device-card");
    await expect(card.locator(".device-name")).toHaveText("Desk PC");
    await expect(card).toContainText("MAC: 02:AA:BB:CC:DD:EE");
    await expect(card).toContainText("Broadcast: 192.168.1.255");
    await expect(card).toContainText("Last sent: Never sent");

    let saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name: "Desk PC",
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
      lastWakeSentAt: null,
    });

    // Duplicate MAC: the server 409 is shown and the inputs are retained.
    await addForm(page).getByLabel("Name").fill("Laptop");
    await addForm(page).getByLabel("MAC address").fill("02-AA-BB-CC-DD-EE");
    await addForm(page).getByRole("button", { name: "Add device" }).click();
    await expect(status).toContainText(
      "A device with that MAC address already exists.",
    );
    await expect(addForm(page).getByLabel("Name")).toHaveValue("Laptop");
    await expect(addForm(page).getByLabel("MAC address")).toHaveValue(
      "02-AA-BB-CC-DD-EE",
    );
    saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);

    // Client-side mirror of C1: a multicast MAC is rejected and inputs remain.
    await addForm(page).getByLabel("MAC address").fill("01:11:22:33:44:55");
    await addForm(page).getByRole("button", { name: "Add device" }).click();
    await expect(addForm(page).getByLabel("MAC address")).toHaveValue(
      "01:11:22:33:44:55",
    );
    await expect(status).toContainText("fix the highlighted fields");
    saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);

    // Edit: clearing the broadcast field sends null and clears the override.
    await card.getByRole("button", { name: "Edit Desk PC" }).click();
    const editForm = status.locator("form.edit-form");
    await editForm.getByLabel("Name").fill("Desk PC");
    await editForm.getByLabel("MAC address").fill("02:AA:BB:CC:DD:EE");
    await editForm.getByLabel("Broadcast override").fill("");
    await editForm.getByRole("button", { name: "Save changes" }).click();

    saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.broadcastAddress).toBeNull();
    // The card names the CLI default, not a server setting, once cleared.
    await expect(card).toContainText("Broadcast: CLI default");

    // Cancel does nothing: the record is unchanged.
    await card.getByRole("button", { name: "Delete Desk PC" }).click();
    await status.getByRole("button", { name: "Cancel" }).click();
    saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);

    // Confirm deletes the record.
    await card.getByRole("button", { name: "Delete Desk PC" }).click();
    await status.getByRole("button", { name: "Confirm delete" }).click();
    await expect(status).toContainText("Device deleted");
    saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(0);
  } finally {
    await server.stop();
  }
});

test("a null override is labelled the CLI default before and after an override", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
  });
  try {
    await page.goto(`${server.url}/`);
    const status = page.getByRole("status");

    // Create with no override: help and card both name the installed CLI default.
    await expect(addForm(page).locator("#add-broadcast-help")).toContainText(
      "wakeonlan CLI default",
    );
    await addForm(page).getByLabel("Name").fill("CLI default PC");
    await addForm(page).getByLabel("MAC address").fill("02:AA:BB:CC:DD:F0");
    await addForm(page).getByRole("button", { name: "Add device" }).click();

    const card = status.locator(".device-card");
    await expect(card).toContainText("Broadcast: CLI default");
    let saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.broadcastAddress).toBeNull();

    // An explicit override wins for that device and is shown as the saved value.
    await card.getByRole("button", { name: "Edit CLI default PC" }).click();
    const editForm = status.locator("form.edit-form");
    await expect(editForm.locator("#edit-broadcast-help")).toContainText(
      "wakeonlan CLI default",
    );
    await editForm.getByLabel("Broadcast override").fill("192.0.2.255");
    await editForm.getByRole("button", { name: "Save changes" }).click();
    await expect(card).toContainText("Broadcast: 192.0.2.255");
    saved = await apiDevices(page, server.url);
    expect(saved[0]!.broadcastAddress).toBe("192.0.2.255");

    // Clearing the override through Edit restores the CLI default label.
    await card.getByRole("button", { name: "Edit CLI default PC" }).click();
    await editForm.getByLabel("Broadcast override").fill("");
    await editForm.getByRole("button", { name: "Save changes" }).click();
    await expect(card).toContainText("Broadcast: CLI default");
    saved = await apiDevices(page, server.url);
    expect(saved[0]!.broadcastAddress).toBeNull();
  } finally {
    await server.stop();
  }
});

test("registrations survive a reload", async ({ page }) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
  });
  try {
    await page.goto(`${server.url}/`);
    const status = page.getByRole("status");

    await addForm(page).getByLabel("Name").fill("Persisted PC");
    await addForm(page).getByLabel("MAC address").fill("02:11:22:33:44:55");
    await addForm(page).getByRole("button", { name: "Add device" }).click();

    await page.reload();
    await expect(status.locator(".device-name")).toHaveText("Persisted PC");
    const saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("Persisted PC");
  } finally {
    await server.stop();
  }
});

test("keyboard submission works and keyboard focus is visible", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
  });
  try {
    await page.goto(`${server.url}/`);
    const status = page.getByRole("status");

    await addForm(page).getByLabel("Name").focus();
    await expect(addForm(page).getByLabel("Name")).toBeFocused();
    const outline = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return getComputedStyle(element).outlineStyle;
    });
    expect(outline).toBe("solid");

    await page.keyboard.type("Keyboard PC");
    await page.keyboard.press("Tab");
    await expect(addForm(page).getByLabel("MAC address")).toBeFocused();
    await page.keyboard.type("02:11:22:33:44:55");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(
      addForm(page).getByRole("button", { name: "Add device" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(status).toContainText("Device added");
    const saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("Keyboard PC");
  } finally {
    await server.stop();
  }
});

test("client name validation rejects over-length and control characters and keeps inputs", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
  });
  try {
    await page.goto(`${server.url}/`);
    const status = page.getByRole("status");
    const nameInput = addForm(page).getByLabel("Name");
    const nameError = addForm(page).locator("#add-name-error");

    // 81 Unicode code points: each emoji is one code point but two UTF-16 units,
    // so this proves code-point counting rather than `string.length`.
    const tooLong = "🐍".repeat(81);
    await nameInput.fill(tooLong);
    await addForm(page).getByLabel("MAC address").fill("02:AA:BB:CC:DD:EE");
    await addForm(page).getByRole("button", { name: "Add device" }).click();
    await expect(nameError).toHaveText("must be at most 80 characters");
    await expect(status).toContainText("fix the highlighted fields");
    await expect(nameInput).toHaveValue(tooLong);
    // The client branch rejects before any request, so the API is unchanged.
    expect(await apiDevices(page, server.url)).toHaveLength(0);

    // A control character is rejected and the input is retained.
    const controlName = "Desk\u0001PC";
    await nameInput.fill(controlName);
    await addForm(page).getByRole("button", { name: "Add device" }).click();
    await expect(nameError).toHaveText("must not contain control characters");
    await expect(status).toContainText("fix the highlighted fields");
    await expect(nameInput).toHaveValue(controlName);
    expect(await apiDevices(page, server.url)).toHaveLength(0);

    // Exactly 80 code points is accepted and reaches the API.
    const exact = "🐍".repeat(80);
    await nameInput.fill(exact);
    await addForm(page).getByRole("button", { name: "Add device" }).click();
    await expect(status).toContainText("Device added");
    const saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe(exact);
  } finally {
    await server.stop();
  }
});

test("a long name and MAC do not cause horizontal overflow at 390px", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
  });
  try {
    await page.goto(`${server.url}/`);
    const status = page.getByRole("status");

    await addForm(page).getByLabel("Name").fill("x".repeat(80));
    await addForm(page).getByLabel("MAC address").fill("02:AA:BB:CC:DD:EE");
    await addForm(page).getByRole("button", { name: "Add device" }).click();
    await expect(status.locator(".device-card")).toBeVisible();

    // The live feedback repeats that name, so it must wrap inside the viewport too.
    const feedback = status.locator(".feedback");
    await expect(feedback).toContainText("Device added");
    await expect(feedback).toContainText("x".repeat(80));
    const feedbackOverflow = await feedback.evaluate((element) =>
      Math.max(0, element.scrollWidth - element.clientWidth),
    );
    expect(feedbackOverflow).toBeLessThanOrEqual(0);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await server.stop();
  }
});
