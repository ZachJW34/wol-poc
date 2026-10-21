import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Browser journeys against the isolated fixture server. The fixture's wake runner is a
 * harmless recorder, so no Wake-on-LAN packet is emitted and no real device is touched.
 */

async function reset(request: APIRequestContext): Promise<void> {
  const response = await request.post("/__test/reset");
  expect(response.ok()).toBeTruthy();
}

async function setBehaviour(request: APIRequestContext, mode: string): Promise<void> {
  const response = await request.post("/__test/behaviour", { data: { mode } });
  expect(response.ok()).toBeTruthy();
}

async function recordedWakes(
  request: APIRequestContext,
): Promise<Array<{ mac: string; mode: string }>> {
  const response = await request.get("/__test/wakes");
  return (await response.json()).wakes;
}

function card(page: Page, index = 0) {
  return page.getByTestId(/^device-/).nth(index);
}

async function openAddDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add device" }).click();
  await expect(page.getByRole("heading", { name: "Add device" })).toBeVisible();
}

async function fillAndSave(page: Page, name: string, mac: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("MAC address").fill(mac);
  await dialog.getByRole("button", { name: "Save" }).click();
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("adds a device and lists it with the canonical MAC", async ({ page, request }) => {
  await page.goto("/");

  await openAddDialog(page);
  await fillAndSave(page, "  Living Room Hub  ", "c8-53-09-f8-8a-32");

  await expect(page.getByTestId("toast")).toContainText("Device saved");
  await expect(card(page)).toContainText("Living Room Hub");
  await expect(card(page)).toContainText("C8:53:09:F8:8A:32");
  await expect(page.getByText("1 device")).toBeVisible();

  // Saving is not waking: the adapter was never invoked.
  expect(await recordedWakes(request)).toEqual([]);
});

test("a saved device survives a page reload", async ({ page, request }) => {
  await page.goto("/");
  await openAddDialog(page);
  await fillAndSave(page, "Study NAS", "aa:bb:cc:dd:ee:02");

  await page.reload();

  // The list is re-read from the real SQLite file, not kept in component state.
  await expect(card(page)).toContainText("Study NAS");
  await expect(card(page)).toContainText("AA:BB:CC:DD:EE:02");
  expect(await recordedWakes(request)).toEqual([]);
});

test("wake says the request was sent, not that the device is online", async ({ page, request }) => {
  await page.goto("/");
  await openAddDialog(page);
  await fillAndSave(page, "Garage Node", "aa:bb:cc:dd:ee:01");

  const wakeButton = card(page).getByRole("button", { name: "Wake" });
  await expect(wakeButton).toBeEnabled();
  await wakeButton.click();

  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Wake request sent");
  await expect(toast).toContainText("Garage Node");
  await expect(toast).not.toContainText("online");

  // The adapter received the canonical MAC resolved from the stored device.
  expect(await recordedWakes(request)).toEqual([{ mac: "AA:BB:CC:DD:EE:01", mode: "sent" }]);

  // The button is usable again, so a deliberate second click can send another packet.
  await expect(wakeButton).toBeEnabled();
});

test("the pending state disables only the waking card", async ({ page, request }) => {
  await setBehaviour(request, "slow");
  await page.goto("/");
  await openAddDialog(page);
  await fillAndSave(page, "Slow Device", "aa:bb:cc:dd:ee:02");

  await openAddDialog(page);
  await fillAndSave(page, "Second Device", "aa:bb:cc:dd:ee:03");

  const first = card(page, 0);
  const second = card(page, 1);

  await first.getByRole("button", { name: "Wake" }).click();

  await expect(first.getByRole("button", { name: "Sending…", exact: true })).toBeDisabled();
  await expect(first.getByRole("button", { name: "Edit Slow Device" })).toBeDisabled();
  await expect(first.getByRole("button", { name: "Delete Slow Device" })).toBeDisabled();

  // Other cards remain usable while one device is waking.
  await expect(second.getByRole("button", { name: "Wake" })).toBeEnabled();

  await expect(page.getByTestId("toast")).toContainText("Wake request sent");
  await expect(first.getByRole("button", { name: "Wake" })).toBeEnabled();
});

test("a failed wake names the action and offers a retry", async ({ page, request }) => {
  await setBehaviour(request, "failed");
  await page.goto("/");
  await openAddDialog(page);
  await fillAndSave(page, "Office PC", "aa:bb:cc:dd:ee:04");

  await card(page).getByRole("button", { name: "Wake" }).click();

  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Wake failed for Office PC");
  await expect(toast).toHaveAttribute("role", "alert");

  await setBehaviour(request, "sent");
  await toast.getByRole("button", { name: "Retry" }).click();
  await expect(toast).toContainText("Wake request sent");

  expect((await recordedWakes(request)).map((wake) => wake.mode)).toEqual(["failed", "sent"]);
});

test("edit updates the card from the server response", async ({ page }) => {
  await page.goto("/");
  await openAddDialog(page);
  await fillAndSave(page, "Old Name", "aa:bb:cc:dd:ee:05");

  const target = card(page);
  await target.getByRole("button", { name: "Edit Old Name" }).click();
  await expect(page.getByRole("heading", { name: "Edit device" })).toBeVisible();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("New Name");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(target).toContainText("New Name");
  await expect(target).toContainText("AA:BB:CC:DD:EE:05");
});

test("delete requires a confirmation that names the device", async ({ page }) => {
  await page.goto("/");
  await openAddDialog(page);
  await fillAndSave(page, "Printer", "aa:bb:cc:dd:ee:06");

  const target = card(page);
  await target.getByRole("button", { name: "Delete Printer" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Printer");

  // Cancel keeps the card, because the server has not confirmed anything.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(target).toBeVisible();

  await target.getByRole("button", { name: "Delete Printer" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

  await expect(page.getByText("No devices saved yet.")).toBeVisible();
  await expect(page.getByText("0 devices")).toBeVisible();
});

test("invalid input shows inline errors and keeps the entered values", async ({ page }) => {
  await page.goto("/");
  await openAddDialog(page);

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Needs a MAC");
  await dialog.getByLabel("MAC address").fill("c8:53:09:f8:8a");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("MAC must be six hex byte pairs")).toBeVisible();
  await expect(dialog.getByLabel("MAC address")).toHaveValue("c8:53:09:f8:8a");
  await expect(dialog.getByLabel("Name")).toHaveValue("Needs a MAC");

  // Nothing was saved, so the list is unchanged.
  await expect(page.getByText("0 devices")).toBeVisible();
});

test("a conflict from the server is reported against the form", async ({ page, request }) => {
  await request.post("/api/devices", {
    headers: { origin: "http://127.0.0.1:7323", "content-type": "application/json" },
    data: { name: "First", mac: "AA:BB:CC:DD:EE:07" },
  });

  await page.goto("/");
  await openAddDialog(page);
  await fillAndSave(page, "Duplicate", "AA:BB:CC:DD:EE:07");

  await expect(page.getByTestId("toast")).toContainText("Save failed");
  await expect(page.getByText("That MAC address is already registered.")).toBeVisible();
});

test("a list failure is visible and retryable", async ({ page }) => {
  let allow = false;
  await page.route("**/api/devices", async (route) => {
    if (!allow) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "Server is unreachable." },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await expect(page.getByText("Server is unreachable.")).toBeVisible();

  allow = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("No devices saved yet.")).toBeVisible();
});

test("keyboard-only use returns focus to the control that opened the dialog", async ({ page }) => {
  await page.goto("/");

  const add = page.getByRole("button", { name: "Add device" });
  await add.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
});

test("the dashboard fits 360px without horizontal scrolling and keeps touch targets", async ({
  page,
}) => {
  await page.goto("/");
  await openAddDialog(page);
  await fillAndSave(page, "Phone Width Device", "aa:bb:cc:dd:ee:08");

  const hasHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalScroll).toBe(false);

  const box = await card(page).getByRole("button", { name: "Wake" }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await expect(page.getByRole("heading", { name: "Phone Width Device" })).toBeVisible();
});

test("reduced motion does not remove the feedback", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await openAddDialog(page);
  await fillAndSave(page, "Reduced Motion", "aa:bb:cc:dd:ee:09");

  await card(page).getByRole("button", { name: "Wake" }).click();
  await expect(page.getByTestId("toast")).toContainText("Wake request sent");

  expect(await recordedWakes(request)).toHaveLength(1);
});
