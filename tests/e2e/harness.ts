/**
 * P04 e2e harness: starts the real Bun HTTP application (`src/server`) with an
 * injectable device repository on a loopback test origin.
 *
 * Playwright's webServer command runs this file directly under Bun. Playwright
 * test files execute under Node, so a spec that needs a different scenario
 * spawns this same file as a subprocess through `startScenarioServer`.
 *
 * Scenario selection is harness-only (`E2E_SCENARIO` / `E2E_PORT`): there is no
 * production environment flag and no HTTP control endpoint. Scenarios are
 * injected fakes except `fixture-sqlite`, which uses a real repository on the
 * temporary database file supplied through `E2E_DATABASE_PATH`.
 *
 * P07 adds the fake wake command through the same harness-only seam: the real
 * `createWakeService` is composed with an injected `RunWakeCommand` chosen by
 * `E2E_RUNNER` (and `E2E_RUNNER_DELAY_MS` for a deferred outcome, so a spec can
 * observe the pending state and a truthful in-flight `WAKE_COOLDOWN`). The
 * production runner is never used here, and nothing reads these values outside
 * this harness file.
 *
 * P08 routes the harness through the production composition root
 * (`startServer` in `src/server/index.ts`), so the browser tests exercise the
 * same startup path production uses: build check, executable probe, store, then
 * listener. Only the C3 runner and the PATH probe are replaced by harmless
 * harness fakes, so no automated run can resolve or execute `wakeonlan`.
 *
 * `devices.ts`, `wake.ts`, and `index.ts` are imported lazily so this file stays
 * loadable under Node: only the Bun subprocess opens a SQLite repository,
 * composes the wake service, or starts the listener.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "../../src/server/config";
import type { DeviceRepository } from "../../src/server/devices";
import type { Device, RunWakeCommand } from "../../src/shared/contracts";

export type Scenario =
  "empty" | "failing" | "fails-then-succeeds" | "fixture" | "fixture-sqlite";

/** Harness-only fake wake outcomes; never a production control. */
export type RunnerOutcome = "ok" | "ok-after-delay" | "failed" | "timeout";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const harnessFile = fileURLToPath(import.meta.url);
const distDir = join(projectRoot, "dist");

// Playwright specs run under Node, so a scenario subprocess must be started with
// the Bun runtime explicitly rather than with the spec's own interpreter.
const bunBinary = typeof Bun !== "undefined" ? process.execPath : "bun";

/**
 * Devices a fixture scenario serves. The fixture is a valid C1 device (server-style
 * UUID, uppercase colon-separated unicast MAC), so the served fixture data could
 * only have come from a repository that accepts its own input rules. The name
 * contains markup so specs can prove the UI renders device names as text rather
 * than as HTML.
 */
export const fixtureDevices: Device[] = [
  {
    id: "3f2c1e4d-5b6a-4c7d-8e9f-0a1b2c3d4e5f",
    name: "<script>alert('name')</script>",
    macAddress: "02:AA:BB:CC:DD:EE",
    broadcastAddress: "192.168.1.255",
    lastWakeSentAt: null,
  },
];

/** The injected repository for a scenario. Fakes only, except `fixture-sqlite`. */
export async function scenarioRepository(
  scenario: Scenario,
): Promise<DeviceRepository> {
  switch (scenario) {
    case "empty":
      return {
        list: () => [],
        get: (id) => null,
        create: () => {
          throw new Error("scenario repository dependency failed");
        },
        update: () => {
          throw new Error("scenario repository dependency failed");
        },
        delete: () => {
          throw new Error("scenario repository dependency failed");
        },
        recordWakeSent: () => {
          throw new Error("scenario repository dependency failed");
        },
        close: () => {},
      };
    case "fixture":
      return {
        list: () => fixtureDevices,
        get: (id) => fixtureDevices.find((device) => device.id === id) ?? null,
        create: () => {
          throw new Error("scenario repository dependency failed");
        },
        update: () => {
          throw new Error("scenario repository dependency failed");
        },
        delete: () => {
          throw new Error("scenario repository dependency failed");
        },
        recordWakeSent: () => {
          throw new Error("scenario repository dependency failed");
        },
        close: () => {},
      };
    case "failing":
      return failingRepository();
    case "fails-then-succeeds": {
      let failed = false;
      const fake = failingRepository();
      return {
        ...fake,
        list: () => {
          if (!failed) {
            failed = true;
            throw new Error("scenario repository dependency failed");
          }
          return [];
        },
      };
    }
    case "fixture-sqlite": {
      const databasePath = process.env.E2E_DATABASE_PATH;
      if (!databasePath) {
        throw new Error("fixture-sqlite scenario requires E2E_DATABASE_PATH");
      }
      // Only the Bun subprocess reaches this branch, so the SQLite module can be
      // imported lazily here.
      const devices = await import("../../src/server/devices");
      return devices.openDeviceRepository(databasePath);
    }
    default: {
      const impossible: never = scenario;
      return impossible;
    }
  }
}

function failingRepository(): DeviceRepository {
  const fail = () => {
    throw new Error("scenario repository dependency failed");
  };
  return {
    list: fail,
    get: fail,
    create: fail,
    update: fail,
    delete: fail,
    recordWakeSent: fail,
    close: () => {},
  };
}

/**
 * The injected fake command (C3 seam). Only the harness supplies it; the real
 * `wakeonlan` executable is never resolved or invoked by these tests.
 */
export function scenarioRunner(
  outcome: RunnerOutcome,
  delayMs: number,
): RunWakeCommand {
  switch (outcome) {
    case "ok":
      return () => Promise.resolve({ kind: "ok" });
    case "failed":
      return () => Promise.resolve({ kind: "failed" });
    case "timeout":
      return () => Promise.resolve({ kind: "timeout" });
    case "ok-after-delay":
      return async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { kind: "ok" };
      };
    default: {
      const impossible: never = outcome;
      return impossible;
    }
  }
}

/** Real configuration path (mode "test"), with the repo build as static root. */
export function harnessConfig(scenario: Scenario, port: number): AppConfig {
  const config = loadConfig(
    {
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_ORIGIN: `http://127.0.0.1:${port}`,
    },
    { mode: "test" },
  );
  return { ...config, staticRoot: distDir };
}

/**
 * Harness-only executable probe: a fixed path, so the real PATH is never scanned
 * and nothing is ever executed. The startup line reports it, which lets a spec
 * prove the composition used the injected probe rather than the installed CLI.
 */
export const harnessProbePath = "/e2e-harness/injected-wakeonlan";

export function harnessProbe(): string {
  return harnessProbePath;
}

/** Start the actual production composition on the loopback test origin. Bun only. */
export async function startHarnessServer(
  scenario: Scenario,
  port: number,
  runner: RunnerOutcome = "ok",
  delayMs = 0,
): Promise<{ url: string }> {
  const config = harnessConfig(scenario, port);
  const repository = await scenarioRepository(scenario);
  // Lazy import keeps this file loadable under Node. The composition root owns the
  // wake service, the startup order, and the graceful close; the harness injects
  // only the C3 runner and the PATH probe.
  const { startServer } = await import("../../src/server/index");
  const server = startServer(config, {
    repository,
    runWakeCommand: scenarioRunner(runner, delayMs),
    wakeExecutableProbe: harnessProbe,
  });
  console.log(
    `[e2e harness] production composition ${scenario} scenario (${runner}${delayMs ? ` +${delayMs}ms` : ""}) serving ${config.staticRoot} at ${server.url}; probe: ${harnessProbePath}`,
  );
  return { url: server.url.toString() };
}

export type ScenarioServer = {
  url: string;
  output: string;
  stop: () => Promise<void>;
};

/**
 * Run one scenario by spawning this file as a Bun subprocess on a free loopback
 * port, so specs (which run under Node) exercise the same application.
 */
export async function startScenarioServer(
  scenario: Scenario,
  env: Record<string, string> = {},
): Promise<ScenarioServer> {
  const port = await freePort();
  const child = spawn(bunBinary, [harnessFile], {
    env: {
      ...process.env,
      E2E_SCENARIO: scenario,
      E2E_PORT: String(port),
      ...env,
    },
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The harness startup line is the only observable channel for what the
  // composition root resolved, so specs read it to confirm the injected probe was
  // used instead of the installed CLI.
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });

  let failure: Error | null = null;
  child.once("error", (error) => {
    failure = error;
  });
  child.once("exit", (code) => {
    failure = new Error(`scenario server exited with code ${code}`);
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let lastStatus: number | null = null;
  while (Date.now() < deadline && failure === null) {
    try {
      // Readiness must be proven through the static built root, never through
      // /api/devices: probing the API would consume a scenario's injected
      // dependency before the browser does.
      const response = await fetch(url);
      if (response.ok) {
        return {
          url,
          output,
          stop: async () => {
            child.kill("SIGTERM");
            await new Promise<void>((resolve) =>
              child.once("exit", () => resolve()),
            );
          },
        };
      }
      lastStatus = response.status;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  child.kill("SIGTERM");
  throw (
    failure ??
    new Error(
      `scenario server for "${scenario}" did not serve the built root on ${url}` +
        (lastStatus === null ? "" : ` (last response: ${lastStatus})`) +
        (output === "" ? "" : ` (output: ${output.trim()})`),
    )
  );
}

async function freePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => resolve());
  });
  const address = socket.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  if (!port) {
    throw new Error("could not allocate a loopback test port");
  }
  return port;
}

/** Allocate an isolated temporary database path for the SQLite scenario. */
export function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "wol-e2e-"));
  return join(dir, "devices.sqlite");
}

if (import.meta.main) {
  if (!existsSync(join(distDir, "index.html"))) {
    console.error(
      `[e2e harness] no build output at ${distDir}. Run "bun run build" first.`,
    );
    process.exit(1);
  }
  const scenario = (process.env.E2E_SCENARIO ?? "empty") as Scenario;
  const runner = (process.env.E2E_RUNNER ?? "ok") as RunnerOutcome;
  const delayMs = Number(process.env.E2E_RUNNER_DELAY_MS ?? 0);
  await startHarnessServer(
    scenario,
    Number(process.env.E2E_PORT ?? 3123),
    runner,
    delayMs,
  );
}
