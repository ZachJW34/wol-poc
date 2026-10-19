/**
 * P08 startup tests: production composition, the PATH executable probe, graceful
 * shutdown, exact-origin behavior with a loopback backend, static guards over the
 * actual server, and database close/reopen persistence.
 *
 * No test here resolves or executes the installed `wakeonlan` CLI. Where the
 * actual production runner is exercised, PATH points at a harmless fixture that
 * records the arguments it is run with, so a record file that never appears proves
 * nothing was executed.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { delimiter, join } from "node:path";
import {
  ConfigError,
  defaultExecutableProbe,
  loadConfig,
  resolveWakeExecutable,
  type AppConfig,
  type ExecutableProbe,
} from "../../src/server/config";
import {
  openDeviceRepository,
  type DeviceRepository,
} from "../../src/server/devices";
import {
  startProductionServer,
  startServer,
  type StartServerOptions,
} from "../../src/server/index";
import {
  createWakeRunner,
  WAKE_EXECUTABLE,
  type RunnerDiagnostics,
  type SpawnCommand,
} from "../../src/server/runner";
import type { Device, RunWakeCommand } from "../../src/shared/contracts";

// Fixture roots: the served static root, a sibling data directory that must never
// be reachable through a static request, and a controlled PATH holding the only
// executable the probe or runner can find.
const fixtureRoot = mkdtempSync(join("/tmp/opencode", "wol-startup-"));
const staticRoot = join(fixtureRoot, "dist");
const dataDir = join(fixtureRoot, "data");
const pathDir = join(fixtureRoot, "fixture-bin");
mkdirSync(staticRoot, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(pathDir, { recursive: true });
writeFileSync(
  join(staticRoot, "index.html"),
  '<!doctype html><div id="app"></div>\n',
);
writeFileSync(join(staticRoot, "app.js"), "console.log(1);\n");
// Dotfiles must exist so a 404 proves the guard ran, not that the file is absent.
writeFileSync(join(staticRoot, ".hidden"), "hidden dotfile\n");
writeFileSync(join(dataDir, "wol.sqlite"), "not a real database\n");
writeFileSync(join(fixtureRoot, "secret.txt"), "application source\n");

const fixtureExecutable = join(pathDir, WAKE_EXECUTABLE);

/**
 * Harmless stand-in for the installed CLI: it records the arguments it is run
 * with. A record file that never appears therefore proves the probe or the run
 * never executed the executable.
 */
function installFixtureExecutable(recordFile: string): void {
  const script = [
    "#!/bin/sh",
    `printf "%s\\n" "$0" "$@" > ${recordFile}`,
    "exit 0",
  ].join("\n");
  writeFileSync(fixtureExecutable, script);
  chmodSync(fixtureExecutable, 0o755);
}

function recordedInvocation(recordFile: string): string[] {
  return readFileSync(recordFile, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** The private spawn seam, pointed at the controlled PATH fixture only. */
function fixtureSpawn(): SpawnCommand {
  return (argv) =>
    Bun.spawn([...argv], {
      env: { PATH: pathDir },
      stdout: "pipe",
      stderr: "pipe",
    });
}

const fakeRunner: RunWakeCommand = async () => ({ kind: "ok" });

/** A repository that records which methods the handler actually reached. */
function recordingRepository(calls: string[]): DeviceRepository {
  const fail = () => {
    throw new Error("startup test repository is read-only");
  };
  return {
    list: () => {
      calls.push("list");
      return [];
    },
    get: () => null,
    create: fail,
    update: fail,
    delete: fail,
    recordWakeSent: fail,
    close: () => {
      calls.push("close");
    },
  };
}

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

function listenerCounts(): Map<NodeJS.Signals, number> {
  const counts = new Map<NodeJS.Signals, number>();
  for (const signal of SIGNALS) {
    counts.set(signal, process.listenerCount(signal));
  }
  return counts;
}

function removeListenersSince(before: Map<NodeJS.Signals, number>): void {
  for (const signal of SIGNALS) {
    for (const listener of process
      .listeners(signal)
      .slice(before.get(signal) ?? 0)) {
      process.removeListener(signal, listener);
    }
  }
}

/** Start the composition root and release its signal listeners afterwards. */
function startFixtureServer(
  config: AppConfig,
  options: StartServerOptions = {},
): { server: ReturnType<typeof startServer>; stop: () => void } {
  const before = listenerCounts();
  const server = startServer(config, options);
  return {
    server,
    stop: () => {
      server.stop();
      removeListenersSince(before);
    },
  };
}

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(
      {
        APP_ORIGIN: "http://127.0.0.1:3000",
      },
      { mode: "test" },
    ),
    staticRoot,
    port: 0,
    ...overrides,
  };
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

describe("executable probe (PATH inspection only)", () => {
  test("resolves the fixture from a controlled PATH and never executes it", () => {
    const record = join(fixtureRoot, "probe-record.txt");
    installFixtureExecutable(record);
    // Non-vacuity: the fixture is a real executable file, so a probe that only
    // inspects PATH still resolves it, and the missing record proves it was not
    // executed.
    expect(existsSync(fixtureExecutable)).toBe(true);
    expect(defaultExecutableProbe({ PATH: pathDir })).toBe(fixtureExecutable);
    expect(existsSync(record)).toBe(false);
  });

  test("PATH entries are checked in order and only executable regular files match", () => {
    const record = join(fixtureRoot, "probe-record-order.txt");
    installFixtureExecutable(record);
    const missing = join(fixtureRoot, "path-missing");
    const nonExecutable = join(fixtureRoot, "path-nonexec");
    const directoryEntry = join(fixtureRoot, "path-direntry");
    mkdirSync(missing, { recursive: true });
    mkdirSync(nonExecutable, { recursive: true });
    mkdirSync(directoryEntry, { recursive: true });
    writeFileSync(join(nonExecutable, WAKE_EXECUTABLE), "#!/bin/sh\nexit 0\n");
    mkdirSync(join(directoryEntry, WAKE_EXECUTABLE), { recursive: true });
    const pathValue = [
      missing,
      "",
      nonExecutable,
      directoryEntry,
      pathDir,
    ].join(delimiter);
    expect(defaultExecutableProbe({ PATH: pathValue })).toBe(fixtureExecutable);
    expect(existsSync(record)).toBe(false);
  });

  test("an unavailable CLI is reported actionably, without running anything", () => {
    const record = join(fixtureRoot, "probe-record-missing.txt");
    installFixtureExecutable(record);
    expect(
      defaultExecutableProbe({ PATH: join(fixtureRoot, "path-missing") }),
    ).toBeNull();
    expect(defaultExecutableProbe({ PATH: "" })).toBeNull();
    expect(defaultExecutableProbe({})).toBeNull();
    const error = (() => {
      try {
        resolveWakeExecutable({ PATH: "" });
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain(WAKE_EXECUTABLE);
    expect(message).toContain("PATH");
    // The actionable message states the check is inspection-only, so an operator
    // is never told to run the CLI to diagnose startup.
    expect(message).toContain("never runs the executable");
    expect(existsSync(record)).toBe(false);
  });
});

describe("startup order: build, probe, store, listener", () => {
  test("a missing executable fails before the store is opened or the server listens", () => {
    const dataCheck = join(fixtureRoot, "data-check-probe");
    const before = listenerCounts();
    expect(() =>
      startServer(
        { ...testConfig(), databasePath: join(dataCheck, "wol.sqlite") },
        { wakeExecutableProbe: () => null },
      ),
    ).toThrow(ConfigError);
    // Non-vacuity: opening the store would have created this directory, so its
    // absence proves the probe failure happened first.
    expect(existsSync(dataCheck)).toBe(false);
    for (const signal of SIGNALS) {
      expect(process.listenerCount(signal)).toBe(before.get(signal) ?? 0);
    }
  });

  test("the build check runs before the probe, so a missing build fails first", () => {
    const unbuiltRoot = join(fixtureRoot, "no-build");
    const dataCheck = join(fixtureRoot, "data-check-build");
    mkdirSync(unbuiltRoot, { recursive: true });
    expect(() =>
      startServer(
        {
          ...testConfig(),
          staticRoot: unbuiltRoot,
          databasePath: join(dataCheck, "wol.sqlite"),
        },
        { wakeExecutableProbe: () => null },
      ),
    ).toThrow('Run "bun run build"');
    expect(existsSync(dataCheck)).toBe(false);
  });

  test("startup probes the environment it is given and never executes the CLI", async () => {
    const record = join(fixtureRoot, "startup-record.txt");
    installFixtureExecutable(record);
    const seen: Array<Record<string, string | undefined>> = [];
    const probe: ExecutableProbe = (env) => {
      seen.push(env);
      return defaultExecutableProbe(env);
    };
    const dir = mkdtempSync(join("/tmp/opencode", "wol-startup-listen-"));
    const started = startFixtureServer(
      testConfig({ databasePath: join(dir, "wol.sqlite") }),
      {
        env: { PATH: pathDir },
        wakeExecutableProbe: probe,
        runWakeCommand: fakeRunner,
      },
    );
    try {
      // Non-vacuity: the probe observed the controlled environment, not process.env.
      expect(seen).toEqual([{ PATH: pathDir }]);
      const response = await fetch(
        `http://${started.server.hostname}:${started.server.port}/`,
      );
      expect(response.status).toBe(200);
      expect(existsSync(record)).toBe(false);
    } finally {
      started.stop();
    }
  });
});

describe("production composition through the actual entry point", () => {
  test("invalid production configuration fails before anything is opened or listened", () => {
    const dataCheck = join(fixtureRoot, "data-check-config");
    const before = listenerCounts();
    expect(() =>
      startProductionServer({
        APP_ORIGIN: "http://127.0.0.1:3000",
        DATABASE_PATH: join(dataCheck, "wol.sqlite"),
      }),
    ).toThrow(ConfigError);
    expect(existsSync(dataCheck)).toBe(false);
    for (const signal of SIGNALS) {
      expect(process.listenerCount(signal)).toBe(before.get(signal) ?? 0);
    }
  });

  test("a legacy WOL_BROADCAST_ADDRESS is inert at startup and cannot reach a command", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-legacy-broadcast-"));
    const dist = join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "index.html"),
      '<!doctype html><div id="app"></div>\n',
    );

    const record = join(dir, "executed.txt");
    installFixtureExecutable(record);
    const databasePath = join(dir, "wol.sqlite");
    const port = await freePort();
    const appOrigin = "https://wol.example.invalid";
    // A value the old required-broadcast parser rejected; it must now be ignored.
    const env = {
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_ORIGIN: appOrigin,
      WOL_BROADCAST_ADDRESS: "224.0.0.1",
      DATABASE_PATH: databasePath,
      PATH: pathDir,
    };

    const diagnostics: RunnerDiagnostics[] = [];
    const previousCwd = process.cwd();
    process.chdir(dir);
    const before = listenerCounts();
    const server = startProductionServer(env, {
      runWakeCommand: createWakeRunner({
        spawn: fixtureSpawn(),
        onDiagnostics: (diagnosticsRecord) =>
          diagnostics.push(diagnosticsRecord),
      }),
    });
    try {
      const url = `http://127.0.0.1:${port}`;
      const created = await fetch(`${url}/api/devices`, {
        method: "POST",
        headers: {
          origin: appOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Desk", macAddress: "02:AA:BB:CC:DD:F1" }),
      });
      expect(created.status).toBe(201);
      const device = ((await created.json()) as { device: Device }).device;

      const wake = await fetch(`${url}/api/devices/${device.id}/wake`, {
        method: "POST",
        headers: { origin: appOrigin },
      });
      expect(wake.status).toBe(200);
      // Non-vacuity: startup succeeded with a value the old parser rejected, and
      // the recorded invocation contains no address at all, so the legacy setting
      // could not have reached the command.
      expect(diagnostics[0]!.argv).toEqual([
        WAKE_EXECUTABLE,
        "02:AA:BB:CC:DD:F1",
      ]);
      expect(recordedInvocation(record)).toEqual([
        fixtureExecutable,
        "02:AA:BB:CC:DD:F1",
      ]);
    } finally {
      server.stop();
      removeListenersSince(before);
      process.chdir(previousCwd);
    }
  });

  test("the production entry point composes the actual runner over a controlled PATH", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-production-"));
    const dist = join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(
      join(dist, "index.html"),
      '<!doctype html><div id="app"></div>\n',
    );
    writeFileSync(join(dist, "app.js"), "console.log(1);\n");
    writeFileSync(join(dist, ".hidden"), "hidden dotfile\n");
    writeFileSync(join(dist, "assets", ".hidden"), "hidden in assets\n");
    writeFileSync(join(dir, "secret.txt"), "application source\n");
    // A sibling data file that must never be reachable through a static request.
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "wol.sqlite"), "not a real database\n");

    const record = join(dir, "executed.txt");
    installFixtureExecutable(record);
    const databasePath = join(dir, "persist", "wol.sqlite");
    const port = await freePort();
    const appOrigin = "https://wol.example.invalid";
    // No broadcast variable: startup must succeed with no global default.
    const env = {
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_ORIGIN: appOrigin,
      DATABASE_PATH: databasePath,
      PATH: pathDir,
    };

    const diagnostics: RunnerDiagnostics[] = [];
    const previousCwd = process.cwd();
    process.chdir(dir);
    const before = listenerCounts();
    const server = startProductionServer(env, {
      runWakeCommand: createWakeRunner({
        spawn: fixtureSpawn(),
        onDiagnostics: (diagnosticsRecord) =>
          diagnostics.push(diagnosticsRecord),
      }),
    });
    try {
      // The backend stays loopback while the browser-facing origin is the private
      // HTTPS proxy origin.
      expect(server.hostname).toBe("127.0.0.1");
      expect(server.port).toBe(port);

      const url = `http://127.0.0.1:${port}`;
      const jsonHeaders = {
        origin: appOrigin,
        "content-type": "application/json",
      };

      // Exact-origin behavior: only the configured HTTPS origin may mutate.
      const created = await fetch(`${url}/api/devices`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ name: "Desk", macAddress: "02:AA:BB:CC:DD:EE" }),
      });
      expect(created.status).toBe(201);
      const device = ((await created.json()) as { device: Device }).device;

      const wrongOrigin = await fetch(`${url}/api/devices`, {
        method: "POST",
        headers: {
          origin: `http://127.0.0.1:${port}`,
          "content-type": "application/json",
        },
        body: '{"name":"Other","macAddress":"02:AA:BB:CC:DD:F0"}',
      });
      expect(wrongOrigin.status).toBe(403);
      const rejected = (await wrongOrigin.json()) as {
        error: { code: string };
      };
      expect(rejected.error.code).toBe("FORBIDDEN_ORIGIN");

      // Static serving over the actual server: nothing outside the build root is
      // exposed, and dotfiles inside it are denied.
      const index = await fetch(`${url}/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<div id="app"></div>');
      // Non-vacuity: every denied target exists on disk, so a 404 can only come
      // from the guard rather than from the file being absent.
      expect(existsSync(join(dist, ".hidden"))).toBe(true);
      expect(existsSync(join(dir, "secret.txt"))).toBe(true);
      expect(existsSync(join(dir, "data", "wol.sqlite"))).toBe(true);
      for (const path of [
        "/.hidden",
        "/assets/%2ehidden",
        "/%2e%2e%2fsecret.txt",
        "/%2e%2e%2fdata%2fwol.sqlite",
        "/data/wol.sqlite",
      ]) {
        const response = await fetch(`${url}${path}`);
        expect(response.status).toBe(404);
        const text = await response.text();
        expect(text).not.toContain("hidden dotfile");
        expect(text).not.toContain("hidden in assets");
        expect(text).not.toContain("application source");
        expect(text).not.toContain("not a real database");
      }

      // The actual production runner reaches the fixture with the exact argv for a
      // device with no saved override: the CLI-default path is the MAC-only form.
      const wake = await fetch(`${url}/api/devices/${device.id}/wake`, {
        method: "POST",
        headers: { origin: appOrigin },
      });
      expect(wake.status).toBe(200);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.argv).toEqual([
        WAKE_EXECUTABLE,
        "02:AA:BB:CC:DD:EE",
      ]);
      expect(diagnostics[0]!.exitCode).toBe(0);
      // Non-vacuity: the record only exists because the fixture child ran; the
      // installed CLI is not on this PATH, so no magic packet can be sent.
      const firstInvocation = recordedInvocation(record);
      expect(firstInvocation).toEqual([fixtureExecutable, "02:AA:BB:CC:DD:EE"]);

      // A saved per-device override still produces the exact -i argv. A second
      // device is used so the per-device cooldown cannot mask this run.
      const overridden = await fetch(`${url}/api/devices`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          name: "Server room",
          macAddress: "02:11:22:33:44:55",
          broadcastAddress: "198.51.100.255",
        }),
      });
      expect(overridden.status).toBe(201);
      const overrideDevice = ((await overridden.json()) as { device: Device })
        .device;
      expect(overrideDevice.broadcastAddress).toBe("198.51.100.255");

      const overrideWake = await fetch(
        `${url}/api/devices/${overrideDevice.id}/wake`,
        {
          method: "POST",
          headers: { origin: appOrigin },
        },
      );
      expect(overrideWake.status).toBe(200);
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[1]!.argv).toEqual([
        WAKE_EXECUTABLE,
        "-i",
        "198.51.100.255",
        "02:11:22:33:44:55",
      ]);
      // Non-vacuity: the fixture rewrites its record on every run, so this can
      // only be the override device's invocation.
      expect(recordedInvocation(record)).toEqual([
        fixtureExecutable,
        "-i",
        "198.51.100.255",
        "02:11:22:33:44:55",
      ]);

      // The store is a real file, so the recorded send time can only come from it.
      expect(existsSync(databasePath)).toBe(true);
    } finally {
      server.stop();
      removeListenersSince(before);
      process.chdir(previousCwd);
    }
  });
});

describe("graceful shutdown", () => {
  async function shutdownBehavior(signal: NodeJS.Signals): Promise<string[]> {
    const calls: string[] = [];
    const repository = recordingRepository(calls);
    const before = listenerCounts();
    const server = startServer(
      testConfig({ databasePath: join(fixtureRoot, "shutdown.sqlite") }),
      {
        repository,
        runWakeCommand: fakeRunner,
        wakeExecutableProbe: () => join(pathDir, WAKE_EXECUTABLE),
      },
    );
    expect(process.listenerCount(signal)).toBe((before.get(signal) ?? 0) + 1);
    const listener = process
      .listeners(signal)
      .slice(before.get(signal) ?? 0)[0] as (...args: unknown[]) => void;

    const exitCodes: Array<number | string | null> = [];
    const originalExit = process.exit;
    process.exit = ((code?: number | string | null): never => {
      exitCodes.push(code ?? 0);
      throw new Error("exit stubbed");
    }) as typeof process.exit;
    try {
      expect(() => listener()).toThrow("exit stubbed");
      // Non-vacuity: the listener is what stops the listener socket, so a fetch
      // afterwards can only fail if shutdown actually ran.
      await expect(
        fetch(`http://${server.hostname}:${server.port}/api/devices`),
      ).rejects.toThrow();
    } finally {
      process.exit = originalExit;
      process.removeListener(signal, listener);
      // The shutdown listener already stopped the socket; stop again only if it is
      // still listening, so this cleanup cannot mask a shutdown that never ran.
      if (server.port !== 0) {
        server.stop();
      }
    }
    expect(exitCodes).toEqual([0]);
    return calls;
  }

  test("SIGTERM stops the listener and closes the repository", async () => {
    expect(await shutdownBehavior("SIGTERM")).toEqual(["close"]);
  });

  test("SIGINT stops the listener and closes the repository", async () => {
    expect(await shutdownBehavior("SIGINT")).toEqual(["close"]);
  });
});

describe("database persistence through the actual server", () => {
  test("the store survives close and reopen", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-startup-persist-"));
    const databasePath = join(dir, "wol.sqlite");
    const config = testConfig({ databasePath });
    const first = openDeviceRepository(databasePath);
    const started = startFixtureServer(config, {
      repository: first,
      runWakeCommand: fakeRunner,
      wakeExecutableProbe: () => join(pathDir, WAKE_EXECUTABLE),
    });
    try {
      const url = `http://${started.server.hostname}:${started.server.port}`;
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

      const wake = await fetch(`${url}/api/devices/${device.id}/wake`, {
        method: "POST",
        headers: { origin: config.appOrigin },
      });
      expect(wake.status).toBe(200);

      first.close();
      // Non-vacuity: a freshly opened repository over the same file can only see
      // committed rows.
      expect(existsSync(databasePath)).toBe(true);
      const second = openDeviceRepository(databasePath);
      expect(second.list()).toEqual([
        { ...device, lastWakeSentAt: expect.any(String) },
      ]);
      second.close();
    } finally {
      first.close();
      started.stop();
    }
  });
});
