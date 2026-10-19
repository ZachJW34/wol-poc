import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import {
  defaultExecutableProbe,
  loadConfig,
  resolveWakeExecutable,
  type AppConfig,
  type ExecutableProbe,
} from "./config.js";
import { openDeviceRepository, type DeviceRepository } from "./devices.js";
import { createWakeRunner } from "./runner.js";
import { createWakeService } from "./wake.js";
import type { RunWakeCommand } from "../shared/contracts.js";

export type StartServerOptions = {
  /**
   * Device store to serve. When omitted, the composition root opens
   * `config.databasePath` (C1). A repository supplied here is still closed on
   * shutdown so the handle is always released.
   */
  repository?: DeviceRepository;
  /**
   * Wake command to use. Production wires the accepted C3 runner; tests inject
   * a fake so no automated run can invoke the real `wakeonlan` executable.
   */
  runWakeCommand?: RunWakeCommand;
  /**
   * P08 executable availability probe. Production resolves the installed CLI
   * from PATH; tests inject a probe (or a controlled PATH) so no automated run
   * resolves or executes the real `wakeonlan` executable. The probe inspects
   * PATH only and never runs the CLI.
   */
  wakeExecutableProbe?: ExecutableProbe;
  /** Environment the probe reads. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

/**
 * Compose the handler and listen. Kept importable so the test harness can start
 * the same application with an injected repository; importing this module never
 * starts a production listener by itself.
 *
 * Startup order is the P08 readiness order: the static build is checked, then
 * the installed CLI is resolved, and only then is the store opened and the
 * server created. A missing build or a missing executable therefore fails
 * startup actionably without creating the runtime data directory or a listener.
 */
export function startServer(
  config: AppConfig,
  options: StartServerOptions = {},
) {
  const indexFile = join(config.staticRoot, "index.html");
  if (!existsSync(indexFile)) {
    throw new Error(
      `Static build not found at ${indexFile}. Run "bun run build" before starting the server.`,
    );
  }

  // P08: availability only. Nothing here runs the executable, so no automated
  // test can send a magic packet.
  resolveWakeExecutable(
    options.env ?? process.env,
    options.wakeExecutableProbe ?? defaultExecutableProbe,
  );

  const repository =
    options.repository ?? openDeviceRepository(config.databasePath);

  // The wake service is the C3 state machine over the accepted runner. Tests
  // inject a fake command; production uses the real runner and system clocks.
  const wake = createWakeService({
    repository,
    runWakeCommand: options.runWakeCommand ?? createWakeRunner(),
  });

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createApp({
      repository,
      appOrigin: config.appOrigin,
      wake,
      staticRoot: config.staticRoot,
    }),
  });

  const shutdown = () => {
    server.stop();
    repository.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

/**
 * Production composition: validate the environment, then start the server.
 * Exposed as an importable function so startup behavior is testable through
 * controlled fixtures without running `bun run start` against live settings.
 */
export function startProductionServer(
  env: Record<string, string | undefined> = process.env,
  options: StartServerOptions = {},
) {
  const config = loadConfig(env, { mode: "production" });
  return startServer(config, { ...options, env });
}

if (import.meta.main) {
  try {
    const server = startProductionServer();
    console.error(`Serving on http://${server.hostname}:${server.port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Startup failed.");
    process.exit(1);
  }
}
