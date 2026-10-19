import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  openDeviceRepository,
  type DeviceRepository,
} from "../../src/server/devices";
import {
  createWakeService,
  WAKE_COOLDOWN_MS,
  type WakeService,
  type WakeServiceOptions,
} from "../../src/server/wake";
import {
  ApplicationError,
  type CommandResult,
  type Device,
  type RunWakeCommand,
} from "../../src/shared/contracts";

const DEFAULT_BROADCAST = "192.168.1.255";

const DESK: Device = {
  id: "6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
  name: "Desk",
  macAddress: "02:AA:BB:CC:DD:EE",
  broadcastAddress: null,
  lastWakeSentAt: null,
};

/** A device whose saved override must win over the configured default. */
const SERVER_ROOM: Device = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "Server room",
  macAddress: "02:11:22:33:44:55",
  broadcastAddress: "10.0.0.255",
  lastWakeSentAt: null,
};

type RecordingRepository = DeviceRepository & { calls: string[] };

function fakeRepository(
  seed: Device[] = [],
  overrides: Partial<DeviceRepository> = {},
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
        id: crypto.randomUUID(),
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

type RunnerCall = { macAddress: string; broadcastAddress: string };
type RecordingRunner = RunWakeCommand & { calls: RunnerCall[] };

function recordingRunner(impl: RunWakeCommand): RecordingRunner {
  const calls: RunnerCall[] = [];
  const runner = ((input: RunnerCall) => {
    calls.push({ ...input });
    return impl(input);
  }) as RecordingRunner;
  runner.calls = calls;
  return runner;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Injectable monotonic clock: no test waits on real time. */
function fakeClock(start: number): {
  nowMs: () => number;
  advance: (ms: number) => void;
  at: () => number;
} {
  let now = start;
  return {
    nowMs: () => now,
    advance: (ms) => {
      now += ms;
    },
    at: () => now,
  };
}

/** Catch a rejection as an application error rather than letting it escape. */
async function rejected(promise: Promise<unknown>): Promise<ApplicationError> {
  try {
    await promise;
  } catch (error) {
    return error as ApplicationError;
  }
  throw new Error("expected the call to reject");
}

function serviceWith(
  repository: DeviceRepository,
  runWakeCommand: RunWakeCommand,
  extra: Partial<WakeServiceOptions> = {},
): WakeService {
  return createWakeService({
    repository,
    runWakeCommand,
    defaultBroadcastAddress: DEFAULT_BROADCAST,
    ...extra,
  });
}

describe("P06 wake service — gate order and effective broadcast", () => {
  test("an unknown id is NOT_FOUND before the runner and reserves no slot", async () => {
    const clock = fakeClock(1000);
    const runner = recordingRunner(async () => ({ kind: "ok" }));
    const repository = fakeRepository([DESK]);
    const service = serviceWith(repository, runner, {
      nowMs: clock.nowMs,
      timestamp: () => "2026-01-02T03:04:05.000Z",
    });

    const error = await rejected(service.wake("missing"));
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.retryAfterMs).toBeUndefined();
    expect(runner.calls).toEqual([]);
    expect(service.isBusy("missing")).toBe(false);

    // Non-vacuity: no cooldown slot was created for the unknown id, so a second
    // attempt at the same instant is still a 404 rather than a 429.
    const second = await rejected(service.wake("missing"));
    expect(second.code).toBe("NOT_FOUND");
    expect(repository.calls).toEqual(["get", "get"]);
  });

  test("the runner receives the saved MAC and the effective broadcast separately", async () => {
    const runner = recordingRunner(async () => ({ kind: "ok" }));
    const service = serviceWith(fakeRepository([DESK, SERVER_ROOM]), runner, {
      nowMs: () => 0,
      timestamp: () => "2026-01-02T03:04:05.000Z",
    });

    await service.wake(SERVER_ROOM.id);
    await service.wake(DESK.id);

    // Non-vacuity: the override exists only on the seeded device, so the second
    // input can only come from the configured default.
    expect(runner.calls).toEqual([
      { macAddress: "02:11:22:33:44:55", broadcastAddress: "10.0.0.255" },
      { macAddress: "02:AA:BB:CC:DD:EE", broadcastAddress: "192.168.1.255" },
    ]);
  });

  test("the wall-clock timestamp is read after command exit", async () => {
    const clock = fakeClock(1000);
    const gate = deferred<CommandResult>();
    const runner = recordingRunner(() => gate.promise);
    const repository = fakeRepository([DESK]);
    const providerCalls: number[] = [];
    const service = serviceWith(repository, runner, {
      nowMs: clock.nowMs,
      timestamp: () => {
        providerCalls.push(clock.at());
        return "2026-01-02T03:04:10.000Z";
      },
    });

    const pending = service.wake(DESK.id);
    clock.advance(3000);
    gate.resolve({ kind: "ok" });
    const device = await pending;

    // Non-vacuity: the clock moved while the command ran, so a timestamp read at
    // request start would have recorded 1000, not the completion time.
    expect(providerCalls).toEqual([4000]);
    expect(device).toEqual({
      ...DESK,
      lastWakeSentAt: "2026-01-02T03:04:10.000Z",
    });
    expect(repository.calls).toEqual(["get", "recordWakeSent"]);
  });

  test("failure and timeout map to their codes and preserve the prior timestamp", async () => {
    const repository = fakeRepository([DESK, SERVER_ROOM]);
    const service = serviceWith(
      repository,
      async ({ macAddress }) => {
        return macAddress === DESK.macAddress
          ? { kind: "failed" }
          : { kind: "timeout" };
      },
      {
        nowMs: () => 0,
        timestamp: () => "2026-01-02T03:04:05.000Z",
      },
    );

    const failed = await rejected(service.wake(DESK.id));
    expect(failed.code).toBe("WAKE_FAILED");
    const timedOut = await rejected(service.wake(SERVER_ROOM.id));
    expect(timedOut.code).toBe("WAKE_TIMEOUT");

    // Non-vacuity: the repository was read but never written, so the stored
    // timestamp is still the prior null.
    expect(repository.calls).toEqual(["get", "get"]);
    expect(repository.get(DESK.id)?.lastWakeSentAt).toBeNull();
    expect(repository.get(SERVER_ROOM.id)?.lastWakeSentAt).toBeNull();
  });
});

describe("P06 wake service — in-flight slot and completion-based cooldown", () => {
  test("the in-flight slot is reserved synchronously before the first await", async () => {
    const gate = deferred<CommandResult>();
    const runner = recordingRunner(() => gate.promise);
    const service = serviceWith(fakeRepository([DESK]), runner, {
      nowMs: () => 0,
      timestamp: () => "2026-01-02T03:04:05.000Z",
    });

    const first = service.wake(DESK.id);
    const duplicate = service.wake(DESK.id);

    // No await has yielded yet, so both calls have already run their synchronous
    // part: one command started, and the duplicate is already rejected.
    expect(runner.calls.length).toBe(1);
    expect(service.isBusy(DESK.id)).toBe(true);

    const error = await rejected(duplicate);
    expect(error.code).toBe("WAKE_COOLDOWN");
    expect(error.retryAfterMs).toBe(WAKE_COOLDOWN_MS);

    gate.resolve({ kind: "ok" });
    await first;
    expect(runner.calls.length).toBe(1);
    expect(service.isBusy(DESK.id)).toBe(false);
  });

  test("an in-flight duplicate is rejected with 5000 even past any expired deadline", async () => {
    const clock = fakeClock(1000);
    const gate = deferred<CommandResult>();
    const runner = recordingRunner(() => gate.promise);
    const service = serviceWith(fakeRepository([DESK]), runner, {
      nowMs: clock.nowMs,
      timestamp: () => "2026-01-02T03:04:05.000Z",
    });

    const pending = service.wake(DESK.id);
    expect(service.isBusy(DESK.id)).toBe(true);

    // A deadline computed from the request start would have expired here; the
    // in-flight rule still answers 429 with the fixed 5000.
    clock.advance(10_000);
    const duplicate = await rejected(service.wake(DESK.id));
    expect(duplicate.code).toBe("WAKE_COOLDOWN");
    expect(duplicate.retryAfterMs).toBe(5000);
    expect(runner.calls.length).toBe(1);

    gate.resolve({ kind: "ok" });
    await pending;
    expect(service.isBusy(DESK.id)).toBe(false);
    expect(runner.calls.length).toBe(1);
  });

  test("the cooldown starts at completion and reports exact remaining ms", async () => {
    const clock = fakeClock(1000);
    const gate = deferred<CommandResult>();
    const runner = recordingRunner(() => gate.promise);
    const service = serviceWith(fakeRepository([DESK]), runner, {
      nowMs: clock.nowMs,
      timestamp: () => "2026-01-02T03:04:05.000Z",
    });

    const pending = service.wake(DESK.id);
    clock.advance(3000);
    gate.resolve({ kind: "ok" });
    await pending;

    // Non-vacuity: a cooldown measured from request start would have only 2000ms
    // left at completion, so the full 5000 proves completion-based timing.
    const atCompletion = await rejected(service.wake(DESK.id));
    expect(atCompletion.code).toBe("WAKE_COOLDOWN");
    expect(atCompletion.retryAfterMs).toBe(5000);

    clock.advance(4001);
    const remaining = await rejected(service.wake(DESK.id));
    expect(remaining.retryAfterMs).toBe(999);

    clock.advance(999);
    await service.wake(DESK.id);
    expect(runner.calls.length).toBe(2);
  });

  test("a failed command still cools down, and busy is released on that path", async () => {
    const clock = fakeClock(0);
    const runner = recordingRunner(async () => ({ kind: "failed" }));
    const service = serviceWith(fakeRepository([DESK]), runner, {
      nowMs: clock.nowMs,
      timestamp: () => "2026-01-02T03:04:05.000Z",
    });

    const error = await rejected(service.wake(DESK.id));
    expect(error.code).toBe("WAKE_FAILED");
    expect(service.isBusy(DESK.id)).toBe(false);

    const cooldown = await rejected(service.wake(DESK.id));
    expect(cooldown.code).toBe("WAKE_COOLDOWN");
    expect(cooldown.retryAfterMs).toBe(5000);
    expect(runner.calls.length).toBe(1);
  });

  test("different device ids proceed independently", async () => {
    const clock = fakeClock(0);
    const gate = deferred<CommandResult>();
    const runner = recordingRunner(async ({ macAddress }) => {
      if (macAddress === DESK.macAddress) {
        return gate.promise;
      }
      return { kind: "ok" };
    });
    const service = serviceWith(fakeRepository([DESK, SERVER_ROOM]), runner, {
      nowMs: clock.nowMs,
      timestamp: () => "2026-01-02T03:04:05.000Z",
    });

    const inFlight = service.wake(DESK.id);
    const other = await service.wake(SERVER_ROOM.id);
    expect(other.lastWakeSentAt).toBe("2026-01-02T03:04:05.000Z");
    expect(service.isBusy(DESK.id)).toBe(true);
    expect(service.isBusy(SERVER_ROOM.id)).toBe(false);

    const duplicate = await rejected(service.wake(DESK.id));
    expect(duplicate.code).toBe("WAKE_COOLDOWN");

    gate.resolve({ kind: "ok" });
    await inFlight;
    expect(runner.calls.length).toBe(2);
  });

  test("busy is released and the cooldown starts when the command rejects", async () => {
    const clock = fakeClock(0);
    const runner = recordingRunner(async () => {
      throw new Error("spawn exploded");
    });
    const service = serviceWith(fakeRepository([DESK]), runner, {
      nowMs: clock.nowMs,
      timestamp: () => "2026-01-02T03:04:05.000Z",
    });

    const error = await rejected(service.wake(DESK.id));
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(service.isBusy(DESK.id)).toBe(false);

    const cooldown = await rejected(service.wake(DESK.id));
    expect(cooldown.code).toBe("WAKE_COOLDOWN");
    expect(runner.calls.length).toBe(1);
  });

  test("a storage failure after a successful command does not retry the command", async () => {
    const clock = fakeClock(0);
    const logs: string[] = [];
    const runner = recordingRunner(async () => ({ kind: "ok" }));
    const repository = fakeRepository([DESK], {
      recordWakeSent: () => {
        throw new Error("SQLITE_BUSY at /tmp/opencode/data/wol.sqlite");
      },
    });
    const service = serviceWith(repository, runner, {
      nowMs: clock.nowMs,
      timestamp: () => "2026-01-02T03:04:05.000Z",
      onInternalLog: (message) => logs.push(message),
    });

    const error = await rejected(service.wake(DESK.id));
    expect(error.code).toBe("INTERNAL_ERROR");
    const text = JSON.stringify({ message: error.message });
    expect(text).not.toContain("SQLITE");
    expect(text).not.toContain("wol.sqlite");
    expect(runner.calls.length).toBe(1);
    expect(logs.join(" ")).toContain("may have been sent");
    expect(service.isBusy(DESK.id)).toBe(false);

    const cooldown = await rejected(service.wake(DESK.id));
    expect(cooldown.code).toBe("WAKE_COOLDOWN");
    expect(runner.calls.length).toBe(1);
  });

  test("a recording ApplicationError after a successful command is sanitized to INTERNAL_ERROR", async () => {
    const clock = fakeClock(0);
    const logs: string[] = [];
    const runner = recordingRunner(async () => ({ kind: "ok" }));
    const repository = fakeRepository([DESK], {
      recordWakeSent: () => {
        throw new ApplicationError(
          "VALIDATION_ERROR",
          "lastWakeSentAt failed a CHECK constraint on wol.devices",
        );
      },
    });
    const service = serviceWith(repository, runner, {
      nowMs: clock.nowMs,
      timestamp: () => "2026-01-02T03:04:05.000Z",
      onInternalLog: (message) => logs.push(message),
    });

    const error = await rejected(service.wake(DESK.id));
    // Non-vacuity: the storage error carries a client code, so a rethrow would
    // expose it; the required response is the sanitized internal code.
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.retryAfterMs).toBeUndefined();
    const text = JSON.stringify({ code: error.code, message: error.message });
    expect(text).not.toContain("VALIDATION_ERROR");
    expect(text).not.toContain("CHECK");
    expect(text).not.toContain("wol.devices");
    expect(logs.join(" ")).toContain("may have been sent");
    expect(runner.calls.length).toBe(1);
    expect(service.isBusy(DESK.id)).toBe(false);

    // Non-vacuity: the retained completion-based cooldown proves the finally
    // cleanup ran on the persistence-error path, and nothing was recorded.
    const cooldown = await rejected(service.wake(DESK.id));
    expect(cooldown.code).toBe("WAKE_COOLDOWN");
    expect(cooldown.retryAfterMs).toBe(5000);
    expect(runner.calls.length).toBe(1);
    expect(repository.get(DESK.id)?.lastWakeSentAt).toBeNull();
  });

  test("a timestamp provider failure after a successful command is sanitized to INTERNAL_ERROR", async () => {
    const clock = fakeClock(0);
    const logs: string[] = [];
    const runner = recordingRunner(async () => ({ kind: "ok" }));
    const repository = fakeRepository([DESK]);
    const service = serviceWith(repository, runner, {
      nowMs: clock.nowMs,
      timestamp: () => {
        throw new ApplicationError(
          "CONFLICT",
          "clock row is busy for wol.devices",
        );
      },
      onInternalLog: (message) => logs.push(message),
    });

    const error = await rejected(service.wake(DESK.id));
    expect(error.code).toBe("INTERNAL_ERROR");
    const text = JSON.stringify({ code: error.code, message: error.message });
    expect(text).not.toContain("CONFLICT");
    expect(text).not.toContain("wol.devices");
    expect(logs.join(" ")).toContain("may have been sent");

    // Non-vacuity: the provider threw before the write, so the recording never
    // happened and the prior timestamp is still null.
    expect(repository.calls).toEqual(["get"]);
    expect(repository.get(DESK.id)?.lastWakeSentAt).toBeNull();
    expect(runner.calls.length).toBe(1);
    expect(service.isBusy(DESK.id)).toBe(false);

    const cooldown = await rejected(service.wake(DESK.id));
    expect(cooldown.code).toBe("WAKE_COOLDOWN");
    expect(cooldown.retryAfterMs).toBe(5000);
    expect(runner.calls.length).toBe(1);
  });
});

describe("P06 wake service — process-local cooldown over a persistent store", () => {
  test("a new service resets the cooldown while the sent timestamp persists", async () => {
    const dir = mkdtempSync(join("/tmp/opencode", "wol-wake-"));
    const path = join(dir, "devices.sqlite3");
    const clock = fakeClock(0);
    const runner = recordingRunner(async () => ({ kind: "ok" }));
    const timestamps = ["2026-01-02T03:04:05.000Z", "2026-01-02T03:04:06.000Z"];
    let index = 0;
    const options = {
      runWakeCommand: runner,
      defaultBroadcastAddress: DEFAULT_BROADCAST,
      nowMs: clock.nowMs,
      timestamp: () => timestamps[index++] ?? "",
    };

    const first = openDeviceRepository(path);
    let second: DeviceRepository | null = null;
    try {
      const created = first.create({
        name: "Desk",
        macAddress: "02:AA:BB:CC:DD:EE",
      });
      const service = createWakeService({ repository: first, ...options });
      const sent = await service.wake(created.id);
      expect(sent.lastWakeSentAt).toBe("2026-01-02T03:04:05.000Z");

      const duringCooldown = await rejected(service.wake(created.id));
      expect(duringCooldown.code).toBe("WAKE_COOLDOWN");

      // Non-vacuity: the row is on disk, so the reopened store can only report
      // the recorded send time, while a brand-new service has no in-memory state.
      first.close();
      expect(existsSync(path)).toBe(true);
      second = openDeviceRepository(path);
      expect(second.get(created.id)?.lastWakeSentAt).toBe(
        "2026-01-02T03:04:05.000Z",
      );

      const reopened = createWakeService({ repository: second, ...options });
      const again = await reopened.wake(created.id);
      expect(again.lastWakeSentAt).toBe("2026-01-02T03:04:06.000Z");
      expect(runner.calls.length).toBe(2);
      expect(second.get(created.id)?.lastWakeSentAt).toBe(
        "2026-01-02T03:04:06.000Z",
      );
    } finally {
      first.close();
      if (second !== null) {
        second.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
