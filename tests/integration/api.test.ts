import { afterEach, afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { ERROR_CODES } from "../../src/shared/contracts";
import { buildStaticMap, createApp } from "../../src/server/app";
import { DeviceStore } from "../../src/server/store";
import type { WakeRunner } from "../../src/server/wake";

/**
 * C3 integration tests against the real handler and a real SQLite file.
 *
 * Every wake here is an injected harmless runner: no subprocess is created, so these
 * tests cannot emit a Wake-on-LAN packet or touch the LAN.
 */

const ORIGIN = "http://127.0.0.1:7123";
const DIST = join(import.meta.dirname, "../../dist");

let dir = "";
let seq = 0;
let opened: DeviceStore[] = [];

type Harness = {
  call: (method: string, path: string, init?: RequestInit) => Promise<Response>;
};

function harness(wake: WakeRunner = async () => ({ status: "sent" })): Harness {
  const store = DeviceStore.open(join(dir, `store-${seq++}.sqlite`));
  opened.push(store);

  const app = createApp({
    store,
    wake,
    appOrigin: ORIGIN,
    staticMap: buildStaticMap(DIST),
    log: () => {},
  });

  const call = (method: string, path: string, init: RequestInit = {}) => {
    const headers = { origin: ORIGIN, "content-type": "application/json", ...(init.headers ?? {}) };
    return app(new Request(`${ORIGIN}${path}`, { ...init, method, headers }));
  };

  return { call };
}

async function payload(response: Response): Promise<Record<string, any>> {
  return response.json();
}

async function createDevice(call: Harness["call"], value: unknown): Promise<Record<string, any>> {
  const response = await call("POST", "/api/devices", { body: JSON.stringify(value) });
  return (await payload(response)).device;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wol-api-"));
});

afterEach(() => {
  for (const store of opened) store.close();
  opened = [];
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("device CRUD", () => {
  it("creates, lists, reads, edits and deletes", async () => {
    const { call } = harness();

    const created = await call("POST", "/api/devices", {
      body: JSON.stringify({ name: "  Living Room Hub  ", mac: "aa-bb-cc-dd-ee-ff" }),
    });
    expect(created.status).toBe(201);
    const device = (await payload(created)).device;
    expect(device.name).toBe("Living Room Hub");
    expect(device.mac).toBe("AA:BB:CC:DD:EE:FF");
    expect(device.id).toBeTruthy();
    expect(device.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const list = await payload(await call("GET", "/api/devices"));
    expect(list.devices).toEqual([device]);

    // Reading a single device is not part of the contract: known route, unsupported method.
    expect((await call("GET", `/api/devices/${device.id}`)).status).toBe(405);

    const edited = await call("PATCH", `/api/devices/${device.id}`, {
      body: JSON.stringify({ name: "Garage Node", mac: "12:22:33:44:55:66" }),
    });
    expect(edited.status).toBe(200);
    const updated = (await payload(edited)).device;
    expect(updated.id).toBe(device.id);
    expect(updated.createdAt).toBe(device.createdAt);
    expect(updated.name).toBe("Garage Node");
    expect(updated.mac).toBe("12:22:33:44:55:66");

    expect((await call("DELETE", `/api/devices/${device.id}`)).status).toBe(204);

    const empty = await payload(await call("GET", "/api/devices"));
    expect(empty.devices).toEqual([]);
    expect((await call("GET", `/api/devices/${device.id}`)).status).toBe(405);
  });

  it("rejects invalid input with field-level detail and never writes", async () => {
    const { call } = harness();

    const response = await call("POST", "/api/devices", {
      body: JSON.stringify({ name: "", mac: "not-a-mac" }),
    });
    expect(response.status).toBe(400);
    const body = await payload(response);
    expect(body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(body.error.fields).toEqual({ name: "Name is required.", mac: expect.any(String) });

    const broadcast = await call("POST", "/api/devices", {
      body: JSON.stringify({ name: "x", mac: "FF:FF:FF:FF:FF:FF" }),
    });
    expect(broadcast.status).toBe(400);

    const mixed = await call("POST", "/api/devices", {
      body: JSON.stringify({ name: "x", mac: "C8:53-09:F8:8A:32" }),
    });
    expect(mixed.status).toBe(400);

    const coerced = await call("POST", "/api/devices", {
      body: JSON.stringify({ name: 1, mac: null }),
    });
    expect(coerced.status).toBe(400);

    const unexpected = await call("POST", "/api/devices", {
      body: JSON.stringify({ name: "ok", mac: "AA:BB:CC:DD:EE:01", broadcast: "255.255.255.255" }),
    });
    expect(unexpected.status).toBe(400);

    const after = await payload(await call("GET", "/api/devices"));
    expect(after.devices).toEqual([]);
  });

  it("rejects non-JSON bodies and wrong content types", async () => {
    const { call } = harness();

    const invalid = await call("POST", "/api/devices", { body: "not json" });
    expect(invalid.status).toBe(400);
    expect((await payload(invalid)).error.code).toBe(ERROR_CODES.INVALID_JSON);

    const wrongType = await call("POST", "/api/devices", {
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "x", mac: "AA:BB:CC:DD:EE:02" }),
    });
    expect(wrongType.status).toBe(415);

    // A charset parameter on application/json is allowed.
    const withCharset = await call("POST", "/api/devices", {
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: "charset ok", mac: "AA:BB:CC:DD:EE:03" }),
    });
    expect(withCharset.status).toBe(201);
  });

  it("maps the unique constraint to DUPLICATE_MAC, and editing a device to its own MAC is not a conflict", async () => {
    const { call } = harness();

    const first = await createDevice(call, { name: "One", mac: "AA:AA:AA:AA:AA:01" });
    const duplicate = await call("POST", "/api/devices", {
      body: JSON.stringify({ name: "Two", mac: "aa-aa-aa-aa-aa-01" }),
    });
    expect(duplicate.status).toBe(409);
    expect((await payload(duplicate)).error.code).toBe(ERROR_CODES.DUPLICATE_MAC);

    const same = await call("PATCH", `/api/devices/${first.id}`, {
      body: JSON.stringify({ name: "One renamed", mac: "AA:AA:AA:AA:AA:01" }),
    });
    expect(same.status).toBe(200);
  });

  it("returns 404 for unknown ids and 405 for unsupported methods", async () => {
    const { call } = harness();

    expect((await call("GET", "/api/devices/does-not-exist")).status).toBe(405);
    expect(
      (
        await call("PATCH", "/api/devices/does-not-exist", {
          body: JSON.stringify({ name: "x", mac: "AA:BB:CC:DD:EE:04" }),
        })
      ).status,
    ).toBe(404);
    expect((await call("DELETE", "/api/devices/does-not-exist")).status).toBe(404);
    expect((await call("POST", "/api/devices/does-not-exist/wake", { body: "{}" })).status).toBe(
      404,
    );

    expect((await call("POST", "/api/health")).status).toBe(405);
    expect((await call("PUT", "/api/devices", { body: "{}" })).status).toBe(405);
    expect((await call("POST", "/api/devices/does-not-exist/wake", { body: "{}" })).status).toBe(
      404,
    );
    expect((await call("GET", "/api/devices/does-not-exist/wake")).status).toBe(405);

    // Unknown API routes are JSON 404, never the SPA HTML.
    const unknown = await call("GET", "/api/nope");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
  });

  it("uses no-store on API responses", async () => {
    const { call } = harness();
    expect((await call("GET", "/api/health")).headers.get("cache-control")).toBe("no-store");
    expect((await call("DELETE", "/api/devices/nope")).headers.get("cache-control")).toBe(
      "no-store",
    );
  });
});

describe("Origin enforcement", () => {
  it("rejects mutations from another origin with 403 before touching the store", async () => {
    const { call } = harness();

    const blockedCreate = await call("POST", "/api/devices", {
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ name: "Nope", mac: "AA:BB:CC:DD:EE:05" }),
    });
    expect(blockedCreate.status).toBe(403);
    expect((await payload(blockedCreate)).error.code).toBe(ERROR_CODES.FORBIDDEN_ORIGIN);

    const device = await createDevice(call, { name: "Ok", mac: "AA:BB:CC:DD:EE:06" });

    for (const [method, path, body] of [
      [
        "PATCH",
        `/api/devices/${device.id}`,
        JSON.stringify({ name: "x", mac: "AA:BB:CC:DD:EE:06" }),
      ],
      ["DELETE", `/api/devices/${device.id}`, undefined],
      ["POST", `/api/devices/${device.id}/wake`, "{}"],
    ] as const) {
      const response = await call(method, path, {
        headers: { origin: "http://localhost:7123" },
        body,
      });
      expect(response.status).toBe(403);
    }

    // The device survived every blocked request.
    const after = await payload(await call("GET", "/api/devices"));
    expect(after.devices).toHaveLength(1);
  });

  it("accepts the exact configured origin and rejects a near match", async () => {
    const { call } = harness();

    const exact = await call("POST", "/api/devices", {
      headers: { origin: ORIGIN },
      body: JSON.stringify({ name: "Exact", mac: "AA:BB:CC:DD:EE:07" }),
    });
    expect(exact.status).toBe(201);

    const near = await call("POST", "/api/devices", {
      headers: { origin: `${ORIGIN}/` },
      body: JSON.stringify({ name: "Near", mac: "AA:BB:CC:DD:EE:08" }),
    });
    expect(near.status).toBe(403);

    // Reads do not require an Origin, but mutations do.
    expect((await call("GET", "/api/devices")).status).toBe(200);
  });
});

describe("wake route", () => {
  it("returns 200 sent for a successful runner, using the stored canonical MAC", async () => {
    const seen: string[] = [];
    const { call } = harness(async (mac) => {
      seen.push(mac);
      return { status: "sent" };
    });

    const device = await createDevice(call, { name: "Wake me", mac: "c8-53-09-f8-8a-32" });
    expect(device.mac).toBe("C8:53:09:F8:8A:32");

    const response = await call("POST", `/api/devices/${device.id}/wake`, { body: "{}" });
    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ status: "sent", deviceId: device.id });
    expect(seen).toEqual(["C8:53:09:F8:8A:32"]);
  });

  it("maps runner outcomes to 502, 503 and 504 without leaking subprocess details", async () => {
    const outcomes = [
      { status: "failed", exitCode: 1 },
      { status: "unavailable" },
      { status: "timeout" },
    ] as const;
    const expected = [
      [ERROR_CODES.WAKE_FAILED, 502],
      [ERROR_CODES.WAKE_UNAVAILABLE, 503],
      [ERROR_CODES.WAKE_TIMEOUT, 504],
    ] as const;

    for (const [index, outcome] of outcomes.entries()) {
      const [code, status] = expected[index]!;
      const { call } = harness(async () => outcome);
      const device = await createDevice(call, { name: "x", mac: `AA:BB:CC:DD:EE:1${index}` });

      const response = await call("POST", `/api/devices/${device.id}/wake`, { body: "{}" });
      expect(response.status).toBe(status);
      const body = await payload(response);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBeTruthy();
    }
  });

  it("never invokes the runner for unknown ids, non-empty bodies, or a foreign Origin", async () => {
    let calls = 0;
    const { call } = harness(async () => {
      calls += 1;
      return { status: "sent" };
    });

    const device = await createDevice(call, { name: "x", mac: "AA:BB:CC:DD:EE:20" });

    expect((await call("POST", "/api/devices/nope/wake", { body: "{}" })).status).toBe(404);
    expect(
      (
        await call("POST", `/api/devices/${device.id}/wake`, {
          body: JSON.stringify({ mac: "AA:BB:CC:DD:EE:21" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/api/devices/${device.id}/wake`, {
          body: JSON.stringify({ id: device.id }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/api/devices/${device.id}/wake`, {
          headers: { origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(calls).toBe(0);
  });

  it("rejects a concurrent wake for the same device with 409, then allows it again", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { call } = harness(async () => {
      await gate;
      return { status: "sent" };
    });

    const device = await createDevice(call, { name: "Busy", mac: "AA:BB:CC:DD:EE:22" });

    const first = call("POST", `/api/devices/${device.id}/wake`, { body: "{}" });
    const second = await call("POST", `/api/devices/${device.id}/wake`, { body: "{}" });
    expect(second.status).toBe(409);
    expect((await payload(second)).error.code).toBe(ERROR_CODES.WAKE_IN_PROGRESS);

    release();
    expect((await first).status).toBe(200);

    const again = await call("POST", `/api/devices/${device.id}/wake`, { body: "{}" });
    expect(again.status).toBe(200);
  });

  it("clears the in-flight set after failures and timeouts", async () => {
    let attempt = 0;
    const { call } = harness(async () => {
      attempt += 1;
      if (attempt === 1) return { status: "failed", exitCode: 1 };
      if (attempt === 2) return { status: "timeout" };
      return { status: "sent" };
    });

    const device = await createDevice(call, { name: "Retry", mac: "AA:BB:CC:DD:EE:23" });

    expect((await call("POST", `/api/devices/${device.id}/wake`, { body: "{}" })).status).toBe(502);
    expect((await call("POST", `/api/devices/${device.id}/wake`, { body: "{}" })).status).toBe(504);
    expect((await call("POST", `/api/devices/${device.id}/wake`, { body: "{}" })).status).toBe(200);
    expect(attempt).toBe(3);
  });

  it("does not serialize wakes for different devices", async () => {
    const order: string[] = [];
    const { call } = harness(async (mac) => {
      order.push(`start ${mac}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end ${mac}`);
      return { status: "sent" };
    });

    const a = await createDevice(call, { name: "A", mac: "AA:BB:CC:DD:EE:30" });
    const b = await createDevice(call, { name: "B", mac: "AA:BB:CC:DD:EE:31" });

    await Promise.all([
      call("POST", `/api/devices/${a.id}/wake`, { body: "{}" }),
      call("POST", `/api/devices/${b.id}/wake`, { body: "{}" }),
    ]);

    expect(order).toEqual([`start ${a.mac}`, `start ${b.mac}`, `end ${a.mac}`, `end ${b.mac}`]);
  });

  it("an edit after the lookup does not cancel an already submitted wake", async () => {
    const seen: string[] = [];
    const { call } = harness(async (mac) => {
      seen.push(mac);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { status: "sent" };
    });

    const device = await createDevice(call, { name: "Race", mac: "AA:BB:CC:DD:EE:32" });

    const wake = call("POST", `/api/devices/${device.id}/wake`, { body: "{}" });
    const edited = await call("PATCH", `/api/devices/${device.id}`, {
      body: JSON.stringify({ name: "Renamed mid-flight", mac: "AA:BB:CC:DD:EE:33" }),
    });
    expect(edited.status).toBe(200);

    const response = await wake;
    expect(response.status).toBe(200);
    expect((await payload(response)).status).toBe("sent");
    // The wake used the MAC resolved before the edit, not the edited one.
    expect(seen).toEqual(["AA:BB:CC:DD:EE:32"]);
  });
});

describe("static serving allowlist", () => {
  it("serves the built index at / and allowlisted assets", async () => {
    const { call } = harness();

    const index = await call("GET", "/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");

    const explicit = await call("GET", "/index.html");
    expect(explicit.status).toBe(200);
  });

  it("refuses hidden files, sourcemaps, unknown types, DB files and traversal attempts", async () => {
    const { call } = harness();

    for (const path of [
      "/.env",
      "/.hidden",
      "/assets/index.js.map",
      "/assets/notes.sql",
      "/../.env",
      "/%2e%2e/.env",
      "/data/wol.db",
      "/favicon.ico",
    ]) {
      const response = await call("GET", path);
      expect(response.status).toBe(404);
    }
  });

  it("does not expose configuration or the database through the API", async () => {
    const { call } = harness();

    for (const path of ["/api/env", "/api/config", "/api/db"]) {
      const response = await call("GET", path);
      expect(response.status).toBe(404);
      expect((await payload(response)).error.code).toBe(ERROR_CODES.NOT_FOUND);
    }
  });
});

describe("persistence", () => {
  it("keeps devices after the store is reopened", async () => {
    const path = join(dir, "persist.db");
    const first = DeviceStore.open(path);
    const device = first.create({ name: "Persisted", mac: "AA:BB:CC:DD:EE:41" });
    first.close();

    const second = DeviceStore.open(path);
    expect(second.list()).toEqual([device]);
    second.close();
  });

  it("fails loudly when the database path is not usable — no in-memory fallback", () => {
    expect(() => DeviceStore.open("/proc/1/cannot-write-here/wol.sqlite")).toThrow();
  });
});
