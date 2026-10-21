import { createApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { DeviceStore } from "../src/server/store";
import { createWakeRunner } from "../src/server/wake";

/**
 * Development launcher: loopback Bun API on 7123 plus a fixed-port loopback Vite dev
 * server on 5173. Both are cleaned up together. Development traffic is not proxied
 * through Tailscale.
 */

const config = loadConfig({ ...process.env, NODE_ENV: "development" });
const store = DeviceStore.open(config.databasePath);

const app = createApp({
  store,
  wake: createWakeRunner(),
  appOrigin: config.appOrigin,
  staticMap: new Map(),
});

const server = Bun.serve({ hostname: config.bind, port: config.port, fetch: app });

const vite = Bun.spawn([process.execPath, "x", "vite", "--port", "5173", "--strictPort"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

let closing = false;
const shutdown = (reason: string) => {
  if (closing) return;
  closing = true;
  console.log(`shutting down (${reason})`);
  vite.kill();
  server.stop();
  store.close();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
vite.exited.then((code) => shutdown(`vite exited ${code}`));

console.log(`dev API: http://127.0.0.1:${config.port}`);
console.log(`dev UI:  http://localhost:5173 (origin ${config.appOrigin})`);
