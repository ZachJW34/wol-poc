import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  createApp,
  type AppDependencies,
  type RequestHandler,
} from "../../src/server/app";
import { loadConfig, type AppConfig } from "../../src/server/config";
import {
  openDeviceRepository,
  type DeviceRepository,
} from "../../src/server/devices";
import { startServer } from "../../src/server/index";
import { MAX_BODY_BYTES } from "../../src/server/http";
import { createWakeService, type WakeService } from "../../src/server/wake";
import {
  ApplicationError,
  type CommandResult,
  type Device,
} from "../../src/shared/contracts";

// Fixture roots: the served static root and a sibling data directory that must
// never be reachable through a static request. Every database these tests open
// is an isolated temp file; nothing here touches the runtime `./data` directory.
const fixtureRoot = mkdtempSync(join("/tmp/opencode", "wol-http-"));
const staticRoot = join(fixtureRoot, "dist");
const dataDir = join(fixtureRoot, "data");
mkdirSync(staticRoot, { recursive: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  join(staticRoot, "index.html"),
  '<!doctype html><div id="app"></div>\n',
);
writeFileSync(join(staticRoot, "app.js"), "console.log(1);\n");
// Dotfiles must exist so a 404 proves the guard ran, not that the file is absent.
writeFileSync(join(staticRoot, ".hidden"), "hidden dotfile\n");
mkdirSync(join(staticRoot, "assets"), { recursive: true });
writeFileSync(join(staticRoot, "assets", ".hidden"), "hidden in assets\n");
writeFileSync(join(dataDir, "wol.sqlite"), "not a real database\n");
writeFileSync(join(fixtureRoot, "secret.txt"), "application source\n");

const APP_ORIGIN = "http://127.0.0.1:3000";

const DEVICE: Device = {
  id: "6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
  name: "Desk",
  macAddress: "02:AA:BB:CC:DD:EE",
  broadcastAddress: null,
  lastWakeSentAt: null,
};

/** A fake repository that records which methods the handler actually reached. */
type RecordingRepository = DeviceRepository & { calls: string[] };

function fakeRepository(
  overrides: Partial<DeviceRepository> = {},
  seed: Device[] = [],
): RecordingRepository {
  const calls: string[] = [];
  const devices = new Map<string, Device>(
    seed.map((device) => [device.id, device]),
  );
  const repository: RecordingRepository = {
    calls,
    list: () => {
      calls.push("list");
      return [...devices.values()];
    },
    get: (id) => {
      calls.push("get");
      return devices.get(id) ?? null;
    },
    create: (input) => {
      calls.push("create");
      const device: Device = {
        id: randomUUID(),
        name: String(input.name),
        macAddress: String(input.macAddress),
        broadcastAddress: null,
        lastWakeSentAt: null,
      };
      devices.set(device.id, device);
      return device;
    },
    update: (id, input) => {
      calls.push("update");
      const existing = devices.get(id);
      if (existing === undefined) {
        throw new ApplicationError("NOT_FOUND", "Device not found.");
      }
      const updated: Device = { ...existing, ...input };
      devices.set(id, updated);
      return updated;
    },
    delete: (id) => {
      calls.push("delete");
      if (!devices.delete(id)) {
        throw new ApplicationError("NOT_FOUND", "Device not found.");
      }
    },
    recordWakeSent: (id, sentAt) => {
      calls.push("recordWakeSent");
      const existing = devices.get(id);
      if (existing === undefined) {
        throw new ApplicationError("NOT_FOUND", "Device not found.");
      }
      devices.set(id, { ...existing, lastWakeSentAt: sentAt });
    },
    close: () => {
      calls.push("close");
    },
  };
  return { ...repository, ...overrides };
}

function appWith(overrides: Partial<AppDependencies> = {}): RequestHandler {
  return createApp({
    repository: fakeRepository(),
    appOrigin: APP_ORIGIN,
    staticRoot,
    ...overrides,
  });
}

function get(
  handler: RequestHandler,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return handler(new Request(`http://127.0.0.1${path}`, init));
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** A body delivered as a stream, so no Content-Length is computed for it. */
function streamBody(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** A command result the test releases at a chosen moment, to hold a wake in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonInit(origin: string | null, contentType?: string): RequestInit {
  const headers: Record<string, string> = {};
  if (origin !== null) {
    headers.origin = origin;
  }
  if (contentType !== undefined) {
    headers["content-type"] = contentType;
  }
  return { method: "POST", headers };
}

describe("GET /api/devices (C2 envelope)", () => {
  test("returns the repository list as { devices: [...] } with no-store", async () => {
    const repository = fakeRepository();
    const response = await get(appWith({ repository }), "/api/devices");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await body(response)).toEqual({ devices: [] });
    expect(repository.calls).toEqual(["list"]);
  });

  test("the repository is the list source", async () => {
    // Non-vacuity: the device is inside the repository, so the response can only
    // match if the handler reads the list from the injected dependency.
    const repository = fakeRepository({}, [DEVICE]);
    const response = await get(appWith({ repository }), "/api/devices");
    expect(await body(response)).toEqual({ devices: [DEVICE] });
    expect(repository.calls).toEqual(["list"]);
  });

  test("list is not gated by the busy predicate", async () => {
    const response = await get(appWith({ isBusy: () => true }), "/api/devices");
    expect(response.status).toBe(200);
  });

  test("GET does not require an origin", async () => {
    const response = await get(appWith(), "/api/devices");
    expect(response.status).toBe(200);
  });
});

describe("CRUD routes", () => {
  test("POST creates and returns 201 { device }", async () => {
    const repository = fakeRepository();
    const response = await get(appWith({ repository }), "/api/devices", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Desk", macAddress: "02:AA:BB:CC:DD:EE" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const envelope = await body(response);
    expect(envelope).toEqual({
      device: {
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
        name: "Desk",
        macAddress: "02:AA:BB:CC:DD:EE",
        broadcastAddress: null,
        lastWakeSentAt: null,
      },
    });
    expect(repository.calls).toEqual(["create"]);
  });

  test("PATCH updates and returns 200 { device }", async () => {
    const repository = fakeRepository();
    const created = await repository.create({
      name: "Desk",
      macAddress: "02:AA:BB:CC:DD:EE",
    });
    const response = await get(
      appWith({ repository }),
      `/api/devices/${created.id}`,
      {
        method: "PATCH",
        headers: { origin: APP_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ name: "Living Room" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      device: { ...created, name: "Living Room" },
    });
    expect(repository.calls).toEqual(["create", "update"]);
  });

  test("DELETE returns 204 with no body", async () => {
    const repository = fakeRepository();
    const created = await repository.create({
      name: "Desk",
      macAddress: "02:AA:BB:CC:DD:EE",
    });
    const response = await get(
      appWith({ repository }),
      `/api/devices/${created.id}`,
      {
        method: "DELETE",
        headers: { origin: APP_ORIGIN },
      },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(repository.calls).toEqual(["create", "delete"]);
  });

  test("devices persist across app reconstruction on the same database", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-persist-"));
    const path = join(dir, "devices.sqlite3");

    const first = openDeviceRepository(path);
    const createResponse = await get(
      appWith({ repository: first }),
      "/api/devices",
      {
        method: "POST",
        headers: { origin: APP_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ name: "Desk", macAddress: "02:AA:BB:CC:DD:EE" }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = ((await body(createResponse)) as { device: Device }).device;
    first.close();

    // Non-vacuity: the row is on disk, and a brand-new app over a freshly opened
    // repository on the same file sees it.
    expect(existsSync(path)).toBe(true);
    const second = openDeviceRepository(path);
    const response = await get(appWith({ repository: second }), "/api/devices");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ devices: [created] });
    second.close();
  });

  test("CRUD persists through the real repository", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-crud-"));
    const path = join(dir, "devices.sqlite3");
    const jsonHeaders = {
      origin: APP_ORIGIN,
      "content-type": "application/json",
    };
    const first = openDeviceRepository(path);
    let second: DeviceRepository | null = null;
    try {
      const handler = appWith({ repository: first });
      const createResponse = await get(handler, "/api/devices", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ name: "Desk", macAddress: "02:AA:BB:CC:DD:EE" }),
      });
      expect(createResponse.status).toBe(201);
      const created = ((await body(createResponse)) as { device: Device })
        .device;

      const patchResponse = await get(handler, `/api/devices/${created.id}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          name: "Living Room",
          broadcastAddress: "192.168.1.255",
        }),
      });
      expect(patchResponse.status).toBe(200);
      const patched = ((await body(patchResponse)) as { device: Device })
        .device;
      expect(patched).toEqual({
        ...created,
        name: "Living Room",
        broadcastAddress: "192.168.1.255",
      });

      // Non-vacuity: the repository is reopened over the same file, so the values
      // can only come from committed rows. C2 has no resource GET, so the change
      // is read back through the collection.
      first.close();
      second = openDeviceRepository(path);
      const reopened = appWith({ repository: second });
      const listed = await get(reopened, "/api/devices");
      expect(listed.status).toBe(200);
      expect(await body(listed)).toEqual({ devices: [patched] });

      const deleted = await get(reopened, `/api/devices/${created.id}`, {
        method: "DELETE",
        headers: { origin: APP_ORIGIN },
      });
      expect(deleted.status).toBe(204);
      const afterDelete = await get(reopened, "/api/devices");
      expect(await body(afterDelete)).toEqual({ devices: [] });
    } finally {
      first.close();
      if (second !== null) {
        second.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a duplicate MAC is a repository conflict", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-duplicate-"));
    const repository = openDeviceRepository(join(dir, "devices.sqlite3"));
    const handler = appWith({ repository });
    const init = {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    };
    const first = await get(handler, "/api/devices", {
      ...init,
      body: JSON.stringify({ name: "Desk", macAddress: "02:AA:BB:CC:DD:EE" }),
    });
    expect(first.status).toBe(201);
    const duplicate = await get(handler, "/api/devices", {
      ...init,
      body: JSON.stringify({ name: "Other", macAddress: "02:aa:bb:cc:dd:ee" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await body(duplicate)).toEqual({
      error: {
        code: "CONFLICT",
        message: "A device with that MAC address already exists.",
      },
    });
    repository.close();
  });

  test("repository-level validation rejects a multicast MAC", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-validation-"));
    const path = join(dir, "devices.sqlite3");
    const repository = openDeviceRepository(path);
    try {
      const handler = appWith({ repository });
      const response = await get(handler, "/api/devices", {
        method: "POST",
        headers: { origin: APP_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ name: "Desk", macAddress: "01:AA:BB:CC:DD:EE" }),
      });
      expect(response.status).toBe(400);
      const envelope = await body(response);
      expect(envelope).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "macAddress must not be a multicast address",
        },
      });
      // Non-vacuity: the database file exists, so a storage failure would have
      // surfaced as a sanitized 500 instead of the shared validation message.
      expect(existsSync(path)).toBe(true);
      const text = JSON.stringify(envelope);
      expect(text).not.toContain("SQLITE");
      expect(text).not.toContain(dir);
      expect(await body(await get(handler, "/api/devices"))).toEqual({
        devices: [],
      });
    } finally {
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("origin check for mutations", () => {
  const cases = [
    { label: "absent", origin: null },
    { label: "the literal string null", origin: "null" },
    { label: "a foreign origin", origin: "https://wol.tailnet.example" },
  ];

  // PATCH and DELETE are resource routes, so the requests must target one; a
  // collection-path PATCH/DELETE is a 405 before the origin check ever runs.
  const RESOURCE_ID = "6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6";

  for (const method of ["POST", "PATCH", "DELETE"]) {
    for (const c of cases) {
      test(`${method} with ${c.label} origin is 403 before any mutation`, async () => {
        const repository = fakeRepository();
        const handler = appWith({ repository });
        const path =
          method === "POST" ? "/api/devices" : `/api/devices/${RESOURCE_ID}`;
        const response = await get(handler, path, {
          method,
          headers: c.origin === null ? {} : { origin: c.origin },
          body: method === "DELETE" ? undefined : '{"name":"x"}',
        });
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await body(response)).toEqual({
          error: {
            code: "FORBIDDEN_ORIGIN",
            message: "Origin does not match the configured application origin.",
          },
        });
        // Non-vacuity: the recording repository proves nothing was mutated.
        expect(repository.calls).toEqual([]);
      });
    }
  }

  test("the origin check runs before the body checks", async () => {
    const repository = fakeRepository();
    const response = await get(appWith({ repository }), "/api/devices", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "text/plain",
      },
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(403);
    expect(repository.calls).toEqual([]);
  });

  test("no CORS headers are emitted", async () => {
    const response = await get(appWith(), "/api/devices", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: '{"name":"Desk","macAddress":"02:AA:BB:CC:DD:EE"}',
    });
    expect(response.status).toBe(201);
    for (const header of [
      "access-control-allow-origin",
      "access-control-allow-methods",
      "access-control-allow-headers",
    ]) {
      expect(response.headers.get(header)).toBeNull();
    }
  });
});

describe("content type and body limits", () => {
  test("a missing content type is 415", async () => {
    const response = await get(appWith(), "/api/devices", jsonInit(APP_ORIGIN));
    expect(response.status).toBe(415);
    expect(await body(response)).toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json.",
      },
    });
  });

  test("a non-JSON content type is 415", async () => {
    const response = await get(
      appWith(),
      "/api/devices",
      jsonInit(APP_ORIGIN, "text/plain"),
    );
    expect(response.status).toBe(415);
  });

  test("application/json with a charset is accepted", async () => {
    const response = await get(
      appWith(),
      "/api/devices",
      jsonInit(APP_ORIGIN, "application/json; charset=utf-8"),
    );
    // The body is empty, so the content type passed and JSON parsing failed.
    expect(response.status).toBe(400);
  });

  test("a charset parameter is matched case-insensitively", async () => {
    const response = await get(
      appWith(),
      "/api/devices",
      jsonInit(APP_ORIGIN, 'application/json; Charset="UTF-8"'),
    );
    expect(response.status).toBe(400);
  });

  test("a content-type parameter other than charset is 415", async () => {
    const repository = fakeRepository();
    const response = await get(
      appWith({ repository }),
      "/api/devices",
      jsonInit(APP_ORIGIN, "application/json; profile=x"),
    );
    expect(response.status).toBe(415);
    expect(await body(response)).toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message:
          "Content-Type must be application/json with an optional charset parameter.",
      },
    });
    // Non-vacuity: the recording repository proves the request never reached the
    // repository, so the 415 is a real rejection rather than a later failure.
    expect(repository.calls).toEqual([]);
  });

  test("a non-utf-8 charset is 415", async () => {
    const repository = fakeRepository();
    const response = await get(
      appWith({ repository }),
      "/api/devices",
      jsonInit(APP_ORIGIN, "application/json; charset=iso-8859-1"),
    );
    expect(response.status).toBe(415);
    expect(await body(response)).toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message:
          "Content-Type must be application/json with an optional charset parameter.",
      },
    });
    expect(repository.calls).toEqual([]);
  });

  test("a charset parameter with no value is 415", async () => {
    const response = await get(
      appWith(),
      "/api/devices",
      jsonInit(APP_ORIGIN, "application/json; charset"),
    );
    expect(response.status).toBe(415);
  });

  test("malformed JSON is 400", async () => {
    const response = await get(
      appWith(),
      "/api/devices",
      jsonInit(APP_ORIGIN, "application/json"),
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request body must be valid JSON.",
      },
    });
  });

  test("an empty body is 400", async () => {
    const response = await get(
      appWith(),
      "/api/devices",
      jsonInit(APP_ORIGIN, "application/json"),
    );
    expect(response.status).toBe(400);
  });

  test("a body over the limit is 413", async () => {
    const repository = fakeRepository();
    const response = await get(appWith({ repository }), "/api/devices", {
      ...jsonInit(APP_ORIGIN, "application/json"),
      body: streamBody("x".repeat(MAX_BODY_BYTES + 1)),
    });
    expect(response.status).toBe(413);
    expect(await body(response)).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: `Request body must be at most ${MAX_BODY_BYTES} bytes.`,
      },
    });
    // Non-vacuity: the recording repository proves the body was rejected before
    // any mutation ran.
    expect(repository.calls).toEqual([]);
  });

  test("the limit is enforced on actual bytes without Content-Length", async () => {
    const repository = fakeRepository();
    const response = await get(appWith({ repository }), "/api/devices", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: streamBody("x".repeat(MAX_BODY_BYTES + 1)),
    });
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.status).toBe(413);
    expect(repository.calls).toEqual([]);
  });

  test("a misleading Content-Length does not bypass the actual-byte limit", async () => {
    const repository = fakeRepository();
    const handler = appWith({ repository });
    const request = new Request("http://127.0.0.1/api/devices", {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        "content-type": "application/json",
        "content-length": "5",
      },
      body: streamBody("x".repeat(MAX_BODY_BYTES + 1)),
    });
    // Non-vacuity: the misleading header reaches the handler, so an
    // implementation that trusted Content-Length would have accepted the body.
    expect(request.headers.get("content-length")).toBe("5");
    const response = await handler(request);
    expect(response.status).toBe(413);
    expect(repository.calls).toEqual([]);
  });

  test("a body at the limit is read, not rejected", async () => {
    const repository = fakeRepository();
    // Trailing JSON whitespace pads a valid payload to exactly the limit, so the
    // assertion measures actual bytes rather than a string that happens to be long.
    const json = JSON.stringify({
      name: "Desk",
      macAddress: "02:AA:BB:CC:DD:EE",
    });
    const atLimit =
      json + " ".repeat(MAX_BODY_BYTES - new TextEncoder().encode(json).length);
    expect(new TextEncoder().encode(atLimit).length).toBe(MAX_BODY_BYTES);
    const response = await get(appWith({ repository }), "/api/devices", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: streamBody(atLimit),
    });
    expect(response.status).toBe(201);
    expect(repository.calls).toEqual(["create"]);
  });

  test("DELETE accepts an empty body", async () => {
    const repository = fakeRepository();
    const response = await get(
      appWith({ repository }),
      "/api/devices/6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
      { method: "DELETE", headers: { origin: APP_ORIGIN } },
    );
    expect(response.status).toBe(404);
    expect(repository.calls).toEqual(["delete"]);
  });

  test("a nonempty DELETE body is 400", async () => {
    const response = await get(
      appWith(),
      "/api/devices/6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
      {
        method: "DELETE",
        headers: { origin: APP_ORIGIN },
        body: "{}",
      },
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "DELETE does not accept a request body.",
      },
    });
  });

  test("an oversized DELETE body is 413", async () => {
    const response = await get(
      appWith(),
      "/api/devices/6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
      {
        method: "DELETE",
        headers: { origin: APP_ORIGIN },
        body: streamBody("x".repeat(MAX_BODY_BYTES + 1)),
      },
    );
    expect(response.status).toBe(413);
  });
});

describe("method dispatch on API routes", () => {
  test("unsupported methods on the collection are 405 with Allow: GET, POST", async () => {
    const response = await get(appWith(), "/api/devices", {
      method: "PUT",
      headers: { origin: APP_ORIGIN },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
    expect(await body(response)).toEqual({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "The device collection supports GET and POST.",
      },
    });
  });

  test("unsupported methods on a resource are 405 with Allow: PATCH, DELETE", async () => {
    const response = await get(
      appWith(),
      "/api/devices/6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
      { method: "GET" },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("PATCH, DELETE");
    expect(await body(response)).toEqual({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "The device resource supports PATCH and DELETE.",
      },
    });
  });

  test("method dispatch runs before the origin check", async () => {
    const repository = fakeRepository();
    const response = await get(appWith({ repository }), "/api/devices", {
      method: "PUT",
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(405);
    expect(repository.calls).toEqual([]);
  });

  test("the wake route is an unknown JSON 404 when no wake service is composed", async () => {
    const response = await get(
      appWith(),
      "/api/devices/6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6/wake",
      { method: "POST", headers: { origin: APP_ORIGIN } },
    );
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      error: { code: "NOT_FOUND", message: "Unknown API route." },
    });
  });

  test("unknown API routes get the JSON 404, never SPA HTML", async () => {
    const response = await get(appWith(), "/api/other");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain('"NOT_FOUND"');
    expect(text).not.toContain('<div id="app"></div>');
  });
});

describe("busy gate", () => {
  const BUSY_ID = "6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6";

  test("PATCH on a busy device is 409 without touching the repository", async () => {
    const repository = fakeRepository();
    const response = await get(
      appWith({ repository, isBusy: (id) => id === BUSY_ID }),
      `/api/devices/${BUSY_ID}`,
      {
        method: "PATCH",
        headers: { origin: APP_ORIGIN, "content-type": "application/json" },
        body: '{"name":"Renamed"}',
      },
    );
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({
      error: { code: "CONFLICT", message: "Device is busy." },
    });
    expect(repository.calls).toEqual([]);
  });

  test("DELETE on a busy device is 409 without touching the repository", async () => {
    const repository = fakeRepository();
    const response = await get(
      appWith({ repository, isBusy: (id) => id === BUSY_ID }),
      `/api/devices/${BUSY_ID}`,
      { method: "DELETE", headers: { origin: APP_ORIGIN } },
    );
    expect(response.status).toBe(409);
    expect(repository.calls).toEqual([]);
  });

  test("create is not gated by the busy predicate", async () => {
    const response = await get(
      appWith({ isBusy: () => true }),
      "/api/devices",
      {
        method: "POST",
        headers: { origin: APP_ORIGIN, "content-type": "application/json" },
        body: '{"name":"Desk","macAddress":"02:AA:BB:CC:DD:EE"}',
      },
    );
    expect(response.status).toBe(201);
  });

  test("the default busy predicate is false", async () => {
    const response = await get(appWith(), `/api/devices/${BUSY_ID}`, {
      method: "PATCH",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: '{"name":"Renamed"}',
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/devices/:id/wake (P06)", () => {
  type RecordingWake = WakeService & { calls: string[] };

  function fakeWake(overrides: Partial<WakeService> = {}): RecordingWake {
    const calls: string[] = [];
    const service: RecordingWake = {
      calls,
      wake: async (id: string) => {
        calls.push(`wake:${id}`);
        return DEVICE;
      },
      isBusy: () => false,
    };
    return { ...service, ...overrides };
  }

  function wakeInit(origin: string | null, bodyText?: string): RequestInit {
    const headers: Record<string, string> = {};
    if (origin !== null) {
      headers.origin = origin;
    }
    return {
      method: "POST",
      headers,
      ...(bodyText === undefined ? {} : { body: bodyText }),
    };
  }

  const WAKE_PATH = `/api/devices/${DEVICE.id}/wake`;

  test("POST wake returns 200 { device, message } with no-store", async () => {
    const wake = fakeWake();
    const response = await get(
      appWith({ wake }),
      WAKE_PATH,
      wakeInit(APP_ORIGIN),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await body(response)).toEqual({
      device: DEVICE,
      message: "Wake packet sent",
    });
    expect(wake.calls).toEqual([`wake:${DEVICE.id}`]);
  });

  test("wake requires the configured origin before the service runs", async () => {
    for (const c of [
      { label: "absent", origin: null },
      { label: "the literal string null", origin: "null" },
      { label: "a foreign origin", origin: "https://evil.example" },
    ]) {
      const wake = fakeWake();
      const response = await get(
        appWith({ wake }),
        WAKE_PATH,
        wakeInit(c.origin),
      );
      expect(response.status).toBe(403);
      // Non-vacuity: the recording service proves the rejected request never
      // reached the state machine, so no slot or cooldown was reserved.
      expect(wake.calls).toEqual([]);
    }
  });

  test("wake has no body contract: empty accepted, nonempty 400, oversized 413", async () => {
    const empty = fakeWake();
    const accepted = await get(
      appWith({ wake: empty }),
      WAKE_PATH,
      wakeInit(APP_ORIGIN),
    );
    expect(accepted.status).toBe(200);

    const nonempty = fakeWake();
    const rejectedBody = await get(
      appWith({ wake: nonempty }),
      WAKE_PATH,
      wakeInit(APP_ORIGIN, "{}"),
    );
    expect(rejectedBody.status).toBe(400);
    expect(await body(rejectedBody)).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Wake does not accept a request body.",
      },
    });
    expect(nonempty.calls).toEqual([]);

    const oversized = fakeWake();
    const tooLarge = await get(appWith({ wake: oversized }), WAKE_PATH, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
      body: streamBody("x".repeat(MAX_BODY_BYTES + 1)),
    });
    expect(tooLarge.status).toBe(413);
    expect(oversized.calls).toEqual([]);
  });

  test("other methods on the wake route are 405 with Allow: POST", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const wake = fakeWake();
      const response = await get(appWith({ wake }), WAKE_PATH, {
        method,
        headers: { origin: APP_ORIGIN },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(await body(response)).toEqual({
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Wake supports POST only.",
        },
      });
      expect(wake.calls).toEqual([]);
    }
  });

  test("method dispatch runs before the origin check on the wake route", async () => {
    const wake = fakeWake();
    const response = await get(appWith({ wake }), WAKE_PATH, {
      method: "PUT",
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(405);
    expect(wake.calls).toEqual([]);
  });

  test("an unknown device is a 404 from the service, never a command", async () => {
    const wake = fakeWake({
      wake: async (id: string) => {
        throw new ApplicationError("NOT_FOUND", "Device not found.");
      },
    });
    const response = await get(
      appWith({ wake }),
      WAKE_PATH,
      wakeInit(APP_ORIGIN),
    );
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      error: { code: "NOT_FOUND", message: "Device not found." },
    });
  });

  test("wake codes map through the shared statuses", async () => {
    for (const [code, status] of [
      ["WAKE_FAILED", 502],
      ["WAKE_TIMEOUT", 504],
    ] as const) {
      const response = await get(
        appWith({
          wake: fakeWake({
            wake: async () => {
              throw new ApplicationError(code, "The wake command failed.");
            },
          }),
        }),
        WAKE_PATH,
        wakeInit(APP_ORIGIN),
      );
      expect(response.status).toBe(status);
      expect(await body(response)).toEqual({
        error: { code, message: "The wake command failed." },
      });
      expect(response.headers.get("retry-after")).toBeNull();
    }
  });

  test("a cooldown is 429 with retryAfterMs and a rounded Retry-After", async () => {
    const response = await get(
      appWith({
        wake: fakeWake({
          wake: async () => {
            throw new ApplicationError("WAKE_COOLDOWN", "Try again later", {
              retryAfterMs: 4001,
            });
          },
        }),
      }),
      WAKE_PATH,
      wakeInit(APP_ORIGIN),
    );
    expect(response.status).toBe(429);
    expect(await body(response)).toEqual({
      error: {
        code: "WAKE_COOLDOWN",
        message: "Try again later",
        retryAfterMs: 4001,
      },
    });
    expect(response.headers.get("retry-after")).toBe("5");
  });

  test("edit and delete conflict with an in-flight wake and are permitted after completion", async () => {
    const gate = deferred<CommandResult>();
    const repository = fakeRepository({}, [DEVICE]);
    // The real state machine over an injected fake command, so the busy gate is
    // the service's own in-flight state rather than a hand-written predicate.
    const service = createWakeService({
      repository,
      runWakeCommand: () => gate.promise,
      defaultBroadcastAddress: "192.168.1.255",
      nowMs: () => 0,
      timestamp: () => "2026-01-02T03:04:05.000Z",
    });
    const handler = appWith({ repository, wake: service });
    const jsonHeaders = {
      origin: APP_ORIGIN,
      "content-type": "application/json",
    };

    const pending = get(handler, WAKE_PATH, wakeInit(APP_ORIGIN));
    // Yield so the wake handler passes its body read and reserves the slot
    // before the edit is dispatched; the service reserves before its first await.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.isBusy(DEVICE.id)).toBe(true);

    const patch = await get(handler, `/api/devices/${DEVICE.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: '{"name":"Renamed"}',
    });
    expect(patch.status).toBe(409);
    expect(await body(patch)).toEqual({
      error: { code: "CONFLICT", message: "Device is busy." },
    });

    const del = await get(handler, `/api/devices/${DEVICE.id}`, {
      method: "DELETE",
      headers: { origin: APP_ORIGIN },
    });
    expect(del.status).toBe(409);

    gate.resolve({ kind: "ok" });
    const wakeResponse = await pending;
    expect(wakeResponse.status).toBe(200);
    expect(await body(wakeResponse)).toEqual({
      device: { ...DEVICE, lastWakeSentAt: "2026-01-02T03:04:05.000Z" },
      message: "Wake packet sent",
    });

    // Non-vacuity: the device is still inside its cooldown, so a permitted edit
    // proves the gate is the in-flight state, not the cooldown.
    const after = await get(handler, `/api/devices/${DEVICE.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: '{"name":"Renamed"}',
    });
    expect(after.status).toBe(200);
    expect(service.isBusy(DEVICE.id)).toBe(false);
    expect(repository.calls).toEqual(["get", "recordWakeSent", "update"]);
  });
});

describe("repository error mapping", () => {
  test("an application error keeps its code and status", async () => {
    const handler = appWith({
      repository: fakeRepository({
        list: () => {
          throw new ApplicationError("CONFLICT", "Device list is busy");
        },
      }),
    });
    const response = await get(handler, "/api/devices");
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({
      error: { code: "CONFLICT", message: "Device list is busy" },
    });
    // Only a 429 cooldown emits `Retry-After`.
    expect(response.headers.get("retry-after")).toBeNull();
  });

  test("retryAfterMs is carried into the envelope", async () => {
    const handler = appWith({
      repository: fakeRepository({
        list: () => {
          throw new ApplicationError("WAKE_COOLDOWN", "Try again later", {
            retryAfterMs: 5000,
          });
        },
      }),
    });
    const response = await get(handler, "/api/devices");
    expect(response.status).toBe(429);
    expect(await body(response)).toEqual({
      error: {
        code: "WAKE_COOLDOWN",
        message: "Try again later",
        retryAfterMs: 5000,
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
  });

  test("Retry-After rounds a non-integral cooldown up to whole seconds", async () => {
    const handler = appWith({
      repository: fakeRepository({
        list: () => {
          throw new ApplicationError("WAKE_COOLDOWN", "Try again later", {
            retryAfterMs: 4001,
          });
        },
      }),
    });
    const response = await get(handler, "/api/devices");
    expect(response.status).toBe(429);
    expect(await body(response)).toEqual({
      error: {
        code: "WAKE_COOLDOWN",
        message: "Try again later",
        retryAfterMs: 4001,
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
  });

  test("an unexpected list failure becomes a sanitized 500", async () => {
    const handler = appWith({
      repository: fakeRepository({
        list: () => {
          throw new Error(
            "SQLITE_ERROR: no such table devices at /tmp/opencode/data/wol.sqlite",
          );
        },
      }),
    });
    const response = await get(handler, "/api/devices");
    expect(response.status).toBe(500);
    const envelope = await body(response);
    expect(envelope).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Device list failed." },
    });
    const text = JSON.stringify(envelope);
    expect(text).not.toContain("SQLITE");
    expect(text).not.toContain("wol.sqlite");
  });

  test("an unexpected CRUD failure becomes a sanitized 500", async () => {
    const handler = appWith({
      repository: fakeRepository({
        create: () => {
          throw new Error(
            "SQLITE_CONSTRAINT_UNIQUE at /tmp/opencode/data/wol.sqlite",
          );
        },
      }),
    });
    const response = await get(handler, "/api/devices", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: '{"name":"Desk","macAddress":"02:AA:BB:CC:DD:EE"}',
    });
    expect(response.status).toBe(500);
    const envelope = await body(response);
    expect(envelope).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Device operation failed." },
    });
    const text = JSON.stringify(envelope);
    expect(text).not.toContain("SQLITE");
    expect(text).not.toContain("wol.sqlite");
  });
});

describe("static serving rooted at the build", () => {
  test("GET serves files inside the static root with no-store", async () => {
    const handler = appWith();
    const index = await get(handler, "/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(await index.text()).toContain('<div id="app"></div>');

    const asset = await get(handler, "/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
  });

  test("HEAD is allowed and returns no body", async () => {
    const handler = appWith();
    const response = await get(handler, "/app.js", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("other methods on static paths are 405 with Allow", async () => {
    const response = await get(appWith(), "/app.js", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(await body(response)).toEqual({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Static assets support GET and HEAD only.",
      },
    });
  });

  test("a missing asset is 404, with no SPA fallback", async () => {
    const response = await get(appWith(), "/missing-asset.js");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("dot segments are normalized by URL parsing before the app sees them", async () => {
    // The URL path state machine compresses a segment that is exactly a single or
    // double dot, including percent-encoded variants (`%2e`, `%2e%2e`). Such
    // requests are rewritten to a path inside the root, so a 404 there proves
    // nothing about the guard. This records where normalization ends.
    for (const [path, pathname] of [
      ["/%2e%2e/package.json", "/package.json"],
      ["/%2e%2e/data/wol.sqlite", "/data/wol.sqlite"],
      ["/.%2e/secret.txt", "/secret.txt"],
    ]) {
      expect(new URL(`http://127.0.0.1${path}`).pathname).toBe(pathname);
    }
  });

  test("encoded traversal that survives URL normalization is denied by the segment guard", async () => {
    const handler = appWith();
    // A segment that only *contains* encoded dots or separators is not a dot
    // segment, so it survives normalization and reaches resolveStaticTarget
    // intact, where the decode/segment guard denies it.
    const cases = [
      {
        // Decodes to `../secret.txt`: the segment guard denies it, and the
        // containment check would deny it too.
        path: "/%2e%2e%2fsecret.txt",
        target: resolve(fixtureRoot, "secret.txt"),
        content: "application source",
      },
      {
        // Decodes to `./index.html`, which is inside the root, so only the
        // segment guard can deny it.
        path: "/%2e%2findex.html",
        target: join(staticRoot, "index.html"),
        content: '<div id="app"></div>',
      },
      {
        // Decodes to `../data/wol.sqlite`: encoded separators are denied.
        path: "/%2e%2e%2fdata%2fwol.sqlite",
        target: resolve(fixtureRoot, "data", "wol.sqlite"),
        content: "not a real database",
      },
    ];
    for (const c of cases) {
      expect(new URL(`http://127.0.0.1${c.path}`).pathname).toBe(c.path);
      // Non-vacuity: the decoded target exists on disk, so the 404 can only come
      // from the guard, not from the file being absent.
      expect(existsSync(c.target)).toBe(true);
      const response = await get(handler, c.path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(c.content);
    }
  });

  test("dotfiles are denied even when they exist inside the static root", async () => {
    const handler = appWith();
    const cases = [
      {
        path: "/.hidden",
        file: join(staticRoot, ".hidden"),
        content: "hidden dotfile",
      },
      {
        path: "/%2ehidden",
        file: join(staticRoot, ".hidden"),
        content: "hidden dotfile",
      },
      {
        path: "/assets/.hidden",
        file: join(staticRoot, "assets", ".hidden"),
        content: "hidden in assets",
      },
      {
        path: "/assets/%2ehidden",
        file: join(staticRoot, "assets", ".hidden"),
        content: "hidden in assets",
      },
    ];
    for (const c of cases) {
      // Non-vacuity: the dotfile exists, so the 404 can only come from the guard.
      expect(existsSync(c.file)).toBe(true);
      const response = await get(handler, c.path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(c.content);
    }
  });

  test("application source and database files are never served", async () => {
    const handler = appWith();
    for (const path of [
      "/secret.txt",
      "/data/wol.sqlite",
      "/src/server/app.ts",
    ]) {
      const response = await get(handler, path);
      expect(response.status).toBe(404);
    }
  });

  test("a symlink inside the build that escapes the root is denied", async () => {
    const escapeRoot = join(fixtureRoot, "escape-root");
    const outside = join(fixtureRoot, "outside-secret.txt");
    mkdirSync(escapeRoot, { recursive: true });
    writeFileSync(outside, "outside the served root\n");
    symlinkSync(outside, join(escapeRoot, "escape.txt"));
    const response = await get(
      createApp({
        repository: fakeRepository(),
        appOrigin: APP_ORIGIN,
        staticRoot: escapeRoot,
      }),
      "/escape.txt",
    );
    expect(response.status).toBe(404);
  });
});

describe("production startup", () => {
  const testConfig = (): AppConfig =>
    loadConfig(
      {
        APP_ORIGIN: "http://127.0.0.1:3000",
        WOL_BROADCAST_ADDRESS: "192.168.1.255",
      },
      { mode: "test" },
    );

  // P08 resolves the installed CLI during startup. These tests inject a probe
  // returning a fixed path, so nothing here scans the real PATH or runs the
  // `wakeonlan` executable; the probe behavior itself is covered in
  // startup.test.ts.
  const probe = (): string => "/fixture/wakeonlan";

  // `startServer` registers handlers for both signals, so cleanup must release
  // exactly the handlers this test added, not any the runner already had.
  function listenerSnapshot(): Map<
    string,
    Array<(...args: unknown[]) => void>
  > {
    const snapshot = new Map<string, Array<(...args: unknown[]) => void>>();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      snapshot.set(signal, [...process.listeners(signal)]);
    }
    return snapshot;
  }

  function removeShutdownListeners(
    before: Map<string, Array<(...args: unknown[]) => void>>,
  ): void {
    for (const [signal, existing] of before) {
      for (const listener of process.listeners(signal).slice(existing.length)) {
        process.removeListener(signal, listener);
      }
    }
  }

  test("a missing build fails startup before listening", () => {
    const unbuiltRoot = join(fixtureRoot, "no-build");
    mkdirSync(unbuiltRoot, { recursive: true });
    const before = process.listenerCount("SIGTERM");
    expect(() =>
      startServer(
        { ...testConfig(), staticRoot: unbuiltRoot },
        { repository: fakeRepository(), wakeExecutableProbe: probe },
      ),
    ).toThrow('Run "bun run build"');
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  test("a missing build fails before the store is opened", () => {
    const unbuiltRoot = join(fixtureRoot, "no-build-2");
    const dataDirForCheck = join(fixtureRoot, "data-check");
    mkdirSync(unbuiltRoot, { recursive: true });
    expect(() =>
      startServer(
        {
          ...testConfig(),
          staticRoot: unbuiltRoot,
          databasePath: join(dataDirForCheck, "wol.sqlite"),
        },
        { wakeExecutableProbe: probe },
      ),
    ).toThrow('Run "bun run build"');
    // Non-vacuity: the store would have created this directory, so its absence
    // proves the build check ran first.
    expect(existsSync(dataDirForCheck)).toBe(false);
  });

  test("startServer serves the configured repository", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-startup-"));
    const databasePath = join(dir, "wol.sqlite");
    const config = { ...testConfig(), staticRoot, databasePath, port: 0 };
    const before = listenerSnapshot();
    const server = startServer(config, { wakeExecutableProbe: probe });
    try {
      const url = `http://${server.hostname}:${server.port}`;
      const created = await fetch(`${url}/api/devices`, {
        method: "POST",
        headers: {
          origin: config.appOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Desk", macAddress: "02:AA:BB:CC:DD:EE" }),
      });
      expect(created.status).toBe(201);
      const device = ((await created.json()) as { device: Device }).device;

      const listed = await fetch(`${url}/api/devices`);
      expect(await listed.json()).toEqual({ devices: [device] });

      // Non-vacuity: the row survives because it is a real database file, not an
      // injected list.
      expect(existsSync(databasePath)).toBe(true);
      const reopened = openDeviceRepository(databasePath);
      expect(reopened.list()).toEqual([device]);
      reopened.close();
    } finally {
      server.stop();
      removeShutdownListeners(before);
    }
  });

  test("the production composition serves the wake route through an injected fake command", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-wake-startup-"));
    const databasePath = join(dir, "wol.sqlite");
    const config = { ...testConfig(), staticRoot, databasePath, port: 0 };
    const before = listenerSnapshot();

    const gate = deferred<CommandResult>();
    const calls: Array<{ macAddress: string; broadcastAddress: string }> = [];
    const repository = openDeviceRepository(databasePath);
    const server = startServer(config, {
      repository,
      // The production runner is wired but never run by tests: this fake stands
      // in for it, so no magic packet can be sent.
      runWakeCommand: async (input) => {
        calls.push({ ...input });
        return gate.promise;
      },
      wakeExecutableProbe: probe,
    });

    try {
      const url = `http://${server.hostname}:${server.port}`;
      const created = await fetch(`${url}/api/devices`, {
        method: "POST",
        headers: {
          origin: config.appOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Desk",
          macAddress: "02-aa-bb-cc-dd-ee",
          broadcastAddress: "10.0.0.255",
        }),
      });
      expect(created.status).toBe(201);
      const device = ((await created.json()) as { device: Device }).device;
      expect(device.macAddress).toBe("02:AA:BB:CC:DD:EE");

      const pendingWake = fetch(`${url}/api/devices/${device.id}/wake`, {
        method: "POST",
        headers: { origin: config.appOrigin },
      });

      // Non-vacuity: the composition root's wake service is what gates edits, so
      // a mid-command edit can only conflict through the injected state machine.
      // The wake request arrives first, so its handler reserves the slot before
      // this one is dispatched.
      const during = await fetch(`${url}/api/devices/${device.id}`, {
        method: "PATCH",
        headers: {
          origin: config.appOrigin,
          "content-type": "application/json",
        },
        body: '{"name":"Renamed"}',
      });
      expect(during.status).toBe(409);

      gate.resolve({ kind: "ok" });
      const wakeResponse = await pendingWake;
      expect(wakeResponse.status).toBe(200);
      const envelope = (await wakeResponse.json()) as {
        device: Device;
        message: string;
      };
      expect(envelope.message).toBe("Wake packet sent");
      expect(envelope.device).toEqual({
        ...device,
        lastWakeSentAt: expect.any(String),
      });

      // Non-vacuity: the injected command observed the normalized MAC and the
      // device override separately from the configured default broadcast.
      expect(calls).toEqual([
        { macAddress: "02:AA:BB:CC:DD:EE", broadcastAddress: "10.0.0.255" },
      ]);

      const after = await fetch(`${url}/api/devices/${device.id}`, {
        method: "PATCH",
        headers: {
          origin: config.appOrigin,
          "content-type": "application/json",
        },
        body: '{"name":"Renamed"}',
      });
      expect(after.status).toBe(200);

      // The row is a real database file, so the recorded send time can only come
      // from the persisted store.
      expect(existsSync(databasePath)).toBe(true);
      const reopened = openDeviceRepository(databasePath);
      expect(reopened.list()[0]?.lastWakeSentAt).toBe(
        envelope.device.lastWakeSentAt,
      );
      reopened.close();
    } finally {
      server.stop();
      repository.close();
      removeShutdownListeners(before);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shutdown closes the repository", () => {
    const repository = fakeRepository();
    const before = listenerSnapshot();
    const server = startServer(
      { ...testConfig(), staticRoot, port: 0 },
      { repository, wakeExecutableProbe: probe },
    );
    const existingTerm = before.get("SIGTERM") ?? [];
    expect(process.listenerCount("SIGTERM")).toBe(existingTerm.length + 1);
    const listener = process
      .listeners("SIGTERM")
      .slice(existingTerm.length)[0] as (...args: unknown[]) => void;

    const exitCodes: Array<number | string | null> = [];
    const originalExit = process.exit;
    process.exit = ((code?: number | string | null): never => {
      exitCodes.push(code ?? 0);
      throw new Error("exit stubbed");
    }) as typeof process.exit;
    try {
      expect(() => listener()).toThrow("exit stubbed");
    } finally {
      process.exit = originalExit;
      removeShutdownListeners(before);
    }
    expect(exitCodes).toEqual([0]);
    expect(repository.calls).toEqual(["close"]);
  });
});
