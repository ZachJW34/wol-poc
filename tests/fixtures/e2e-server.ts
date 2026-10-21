import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildStaticMap, createApp } from "../../src/server/app";
import { DeviceStore } from "../../src/server/store";
import type { WakeOutcome, WakeRunner } from "../../src/server/wake";

/**
 * Isolated E2E server: the real handler and a real SQLite file, but the wake runner is a
 * harmless recorder. No subprocess is created, so these tests cannot emit a Wake-on-LAN
 * packet or touch the LAN. Control routes exist only for the browser tests.
 */

const port = Number(process.env.E2E_PORT ?? 7323);
const origin = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), "wol-e2e-"));
const store = DeviceStore.open(join(dir, "e2e.sqlite"));

type Mode = "sent" | "failed" | "unavailable" | "timeout" | "slow";

let mode: Mode = "sent";
const seen: Array<{ mac: string; mode: Mode }> = [];

const wake: WakeRunner = async (mac) => {
  seen.push({ mac, mode });

  if (mode === "slow") {
    // A bounded delay so the pending UI state can be observed. Still no subprocess.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { status: "sent" };
  }
  if (mode === "sent") return { status: "sent" };
  if (mode === "unavailable") return { status: "unavailable" };
  if (mode === "timeout") return { status: "timeout" };
  return { status: "failed", exitCode: 1 };
};

const app = createApp({
  store,
  wake,
  appOrigin: origin,
  staticMap: buildStaticMap(join(import.meta.dirname, "../../dist")),
  log: (message) => console.error(`[e2e] ${message}`),
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;

    if (path === "/__test/behaviour" && request.method === "POST") {
      const body = (await request.json()) as { mode: Mode };
      mode = body.mode;
      return Response.json({ ok: true, mode });
    }

    if (path === "/__test/wakes" && request.method === "GET") {
      return Response.json({ wakes: seen });
    }

    if (path === "/__test/reset" && request.method === "POST") {
      for (const device of store.list()) store.remove(device.id);
      seen.length = 0;
      mode = "sent";
      return Response.json({ ok: true });
    }

    return app(request);
  },
});

console.log(
  `e2e server: http://127.0.0.1:${server.port} (origin ${origin}, db ${join(dir, "e2e.sqlite")})`,
);

const shutdown = () => {
  server.stop();
  store.close();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
