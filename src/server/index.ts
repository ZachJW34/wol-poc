import { join } from "node:path";

import { buildStaticMap, createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { DeviceStore } from "./store";
import { createWakeRunner } from "./wake";

/**
 * Real process wiring. Importing this module does nothing; only the entrypoint binds
 * a socket. The bind address is always loopback.
 */

function startup(): void {
  const config = loadConfig();

  let store: DeviceStore;
  try {
    store = DeviceStore.open(config.databasePath);
  } catch (error) {
    console.error(`startup failed: ${describe(error)}`);
    process.exit(1);
    return;
  }

  const distDir = join(process.cwd(), "dist");
  const staticMap = buildStaticMap(distDir);

  if (staticMap.size === 0) {
    if (config.env === "production") {
      console.error("startup failed: production needs a UI build. Run `bun run build` first.");
      store.close();
      process.exit(1);
      return;
    }
    // Development and isolated test fixtures may run the API without a built UI.
    console.warn("no UI build found; serving the API only (run `bun run build` for the UI).");
  }

  const app = createApp({
    store,
    wake: createWakeRunner(),
    appOrigin: config.appOrigin,
    staticMap,
  });

  const server = Bun.serve({ hostname: config.bind, port: config.port, fetch: app });
  console.log(`WoL app: http://127.0.0.1:${config.port} (allowed origin ${config.appOrigin})`);

  let closing = false;
  const shutdown = (reason: string) => {
    if (closing) return;
    closing = true;
    console.log(`shutting down (${reason})`);
    server.stop();
    store.close();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) startup();
