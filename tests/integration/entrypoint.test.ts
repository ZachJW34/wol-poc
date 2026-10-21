import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { DeviceStore } from "../../src/server/store";

/**
 * Real entrypoint checks, run as child processes so the test process never binds the
 * production port. Each child runs from an isolated working directory, so the project's
 * own `.env` cannot leak into it. No wake route is called here, so no packet can be emitted.
 */

const ROOT = join(import.meta.dirname, "../..");
const ENTRY = join(ROOT, "src/server/index.ts");

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wol-entry-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function spawn(args: Record<string, string>) {
  return Bun.spawn(["bun", ENTRY], {
    cwd: dir,
    // A minimal environment: nothing from the project's .env is inherited.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...args },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (text.includes("\n")) break;
  }
  reader.releaseLock();
  return text.trim();
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop();
  if (typeof port !== "number") throw new Error("could not reserve a test port");
  return port;
}

describe("entrypoint", () => {
  it("fails production startup without APP_ORIGIN and never binds a socket", async () => {
    const child = spawn({ NODE_ENV: "production", DATABASE_PATH: join(dir, "no-origin.sqlite") });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(stderr).toContain("APP_ORIGIN");
  }, 20000);

  it("fails production startup when the UI build is absent", async () => {
    const child = spawn({
      NODE_ENV: "production",
      APP_ORIGIN: "https://phone.ts.net",
      DATABASE_PATH: join(dir, "no-build.sqlite"),
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(stderr).toContain("UI build");
  }, 20000);

  it("binds loopback, serves the API, and closes the database on SIGTERM", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const databasePath = join(dir, "entry.sqlite");

    const child = spawn({
      NODE_ENV: "test",
      APP_ORIGIN: origin,
      PORT: String(port),
      DATABASE_PATH: databasePath,
    });
    const startupLine = await readLine(child.stdout as ReadableStream<Uint8Array>);
    expect(startupLine).toContain(`http://127.0.0.1:${port}`);

    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);

    const created = await fetch(`${origin}/api/devices`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "Entry device", mac: "AA:BB:CC:DD:EE:60" }),
    });
    expect(created.status).toBe(201);

    // A foreign Origin is refused over the real socket too.
    const blocked = await fetch(`${origin}/api/devices`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Blocked", mac: "AA:BB:CC:DD:EE:61" }),
    });
    expect(blocked.status).toBe(403);

    child.kill("SIGTERM");
    const shutdownLine = await readLine(child.stdout as ReadableStream<Uint8Array>);
    expect(shutdownLine).toContain("shutting down");
    expect(await child.exited).toBe(0);

    // The database survived the shutdown, and only the allowed device is in it.
    const reopened = DeviceStore.open(databasePath);
    expect(reopened.list().map((device) => device.name)).toEqual(["Entry device"]);
    reopened.close();
  }, 20000);
});
