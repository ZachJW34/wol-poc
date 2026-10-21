import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { loadConfig } from "../../src/server/config";
import { buildStaticMap, createApp } from "../../src/server/app";
import { DeviceStore } from "../../src/server/store";

/**
 * Real loopback socket checks. The wake runner injected here is harmless, so no
 * Wake-on-LAN packet is emitted by these tests.
 */

let dir = "";
let store: DeviceStore;
let server: ReturnType<typeof Bun.serve>;
let origin = "";

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop();
  if (typeof port !== "number") throw new Error("could not reserve a test port");
  return port;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wol-socket-"));
  store = DeviceStore.open(join(dir, "wol.sqlite"));

  const config = loadConfig({ NODE_ENV: "test", APP_ORIGIN: "http://127.0.0.1:7123" });
  expect(config.bind).toBe("127.0.0.1");

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;

  const app = createApp({
    store,
    wake: async () => ({ status: "sent" }),
    appOrigin: origin,
    staticMap: buildStaticMap(join(import.meta.dirname, "../../dist")),
    log: () => {},
  });

  server = Bun.serve({ hostname: config.bind, port, fetch: app });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("loopback HTTP", () => {
  it("binds loopback only", () => {
    expect(server.hostname).toBe("127.0.0.1");
  });

  it("answers health over a real socket", async () => {
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("creates a device over the socket and reads it back", async () => {
    const created = await fetch(`${origin}/api/devices`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "Socket device", mac: "c8:53:09:f8:8a:32" }),
    });
    expect(created.status).toBe(201);
    const device = (await created.json()).device;
    expect(device.mac).toBe("C8:53:09:F8:8A:32");

    const list = await fetch(`${origin}/api/devices`);
    expect((await list.json()).devices).toEqual([device]);
  });

  it("refuses a foreign Origin over the socket before any wake", async () => {
    const created = await fetch(`${origin}/api/devices`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "Guarded", mac: "AA:BB:CC:DD:EE:50" }),
    });
    const device = (await created.json()).device;

    const response = await fetch(`${origin}/api/devices/${device.id}/wake`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN_ORIGIN");

    // The device is still present, so the blocked request never reached the store.
    const list = await fetch(`${origin}/api/devices`);
    const names = (await list.json()).devices.map((d: { name: string }) => d.name);
    expect(names).toContain("Guarded");
  });

  it("serves the built UI at / and refuses hidden files over the socket", async () => {
    const index = await fetch(`${origin}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");

    const hidden = await fetch(`${origin}/.env`);
    expect(hidden.status).toBe(404);
  });
});
