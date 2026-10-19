import { expect, test, type Page } from "@playwright/test";
import {
  harnessProbePath,
  startScenarioServer,
  tempDatabasePath,
} from "./harness";

/**
 * P08 integration: the browser talks to the production composition root
 * (`startServer` in `src/server/index.ts`), so the startup path the browser
 * exercises is the one production uses: build check, executable probe, store,
 * then listener. Only the C3 runner and the PATH probe are harness fakes, so
 * nothing here resolves or executes the installed `wakeonlan` CLI.
 */
type ApiDevice = {
  name: string;
  macAddress: string;
  broadcastAddress: string | null;
  lastWakeSentAt: string | null;
};

async function apiDevices(page: Page, origin: string): Promise<ApiDevice[]> {
  const response = await page.request.get(`${origin}/api/devices`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.devices as ApiDevice[];
}

test("the production composition serves the built app and records a wake through the injected runner", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
  });
  try {
    // Non-vacuity: the startup line is printed by the composition root and reports
    // the harness probe, so the injected probe — not a real PATH lookup — is what
    // startup resolved.
    expect(server.output).toContain("production composition");
    expect(server.output).toContain(harnessProbePath);

    await page.goto(`${server.url}/`);
    const status = page.getByRole("status");
    await expect(status).toContainText("No devices yet");

    const form = page.locator("form.add-form");
    await form.getByLabel("Name").fill("Desk PC");
    await form.getByLabel("MAC address").fill("02:aa:bb:cc:dd:ee");
    await form.getByRole("button", { name: "Add device" }).click();
    await expect(status).toContainText("Device added");

    const card = status.locator(".device-card");
    await card.getByRole("button", { name: "Wake Desk PC" }).click();
    await expect(status).toContainText("Wake packet sent");

    const saved = await apiDevices(page, server.url);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.lastWakeSentAt).not.toBeNull();
    await expect(card.locator("time")).toHaveAttribute(
      "datetime",
      saved[0]!.lastWakeSentAt!,
    );

    // Reload: the record can only come from the persisted store, not from UI state.
    await page.reload();
    const reloaded = await apiDevices(page, server.url);
    expect(reloaded).toEqual(saved);
    await expect(status.locator(".device-card")).toContainText("Desk PC");
    await expect(status.locator(".device-card")).toContainText(
      "MAC: 02:AA:BB:CC:DD:EE",
    );
  } finally {
    await server.stop();
  }
});

test("the actual server denies paths outside the build root and foreign origins", async ({
  page,
}) => {
  const server = await startScenarioServer("fixture-sqlite", {
    E2E_DATABASE_PATH: tempDatabasePath(),
  });
  try {
    await page.goto(`${server.url}/`);

    // Static serving over the actual server: nothing outside the build root is
    // exposed, and dotfiles inside it are denied.
    for (const path of [
      "/%2e%2e%2fpackage.json",
      "/.hidden",
      "/data/wol.sqlite",
    ]) {
      const response = await page.request.get(`${server.url}${path}`);
      expect(response.status()).toBe(404);
    }

    // The loopback backend serves the page, but mutations are gated on the exact
    // configured origin. The accepted case must come from a real browser request,
    // because Playwright's APIRequestContext does not send an Origin by itself.
    const jsonHeaders = {
      "content-type": "application/json",
    };

    // The visible add form is a browser fetch, so it carries the browser's own
    // origin and is accepted.
    const form = page.locator("form.add-form");
    await form.getByLabel("Name").fill("Desk");
    await form.getByLabel("MAC address").fill("02:AA:BB:CC:DD:EE");
    await form.getByRole("button", { name: "Add device" }).click();
    await expect(page.getByRole("status")).toContainText("Device added");

    // Non-vacuity for the APIRequestContext checks below: an explicitly originated
    // request to the configured origin is accepted, so the 403s can only come from
    // the origin itself, not from a header the tool never sends.
    const explicitOrigin = await page.request.post(
      `${server.url}/api/devices`,
      {
        headers: { ...jsonHeaders, origin: server.url },
        data: '{"name":"Explicit","macAddress":"02:AA:BB:CC:DD:F1"}',
      },
    );
    expect(explicitOrigin.status()).toBe(201);

    const foreign = await page.request.post(`${server.url}/api/devices`, {
      headers: { ...jsonHeaders, origin: "https://evil.example" },
      data: '{"name":"Other","macAddress":"02:AA:BB:CC:DD:F0"}',
    });
    expect(foreign.status()).toBe(403);
    const envelope = await foreign.json();
    expect(envelope.error.code).toBe("FORBIDDEN_ORIGIN");

    // A request that carries no Origin at all is rejected too, which is why the
    // accepted case above uses the browser's own request.
    const missingOrigin = await page.request.post(`${server.url}/api/devices`, {
      headers: jsonHeaders,
      data: '{"name":"Missing","macAddress":"02:AA:BB:CC:DD:F2"}',
    });
    expect(missingOrigin.status()).toBe(403);
  } finally {
    await server.stop();
  }
});
