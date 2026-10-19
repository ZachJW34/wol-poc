import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  createWakeRunner,
  MAX_DIAGNOSTIC_BYTES,
  WAKE_COMMAND_TIMEOUT_MS,
  WAKE_EXECUTABLE,
  type RunnerDiagnostics,
  type SpawnCommand,
  type SpawnedProcess,
} from "../../src/server/runner";

const FIXTURES = new URL("../fixtures/", import.meta.url);

function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

/** What the private seam observed for one run: argv, exit, and any kill signal. */
type SpawnRecord = {
  argv: readonly string[];
  child: SpawnedProcess;
  exitSettled: boolean;
  exitCode: number | null;
  signals: Array<number | NodeJS.Signals>;
};

/**
 * Test seam: it records the argv the runner tried and maps the attempted
 * `wakeonlan` invocation onto a harmless fixture script. No test here resolves
 * or invokes the real `wakeonlan` executable, and no magic packet is sent.
 */
function fixtureSeam(records: SpawnRecord[], fixture: string): SpawnCommand {
  return (argv) => {
    const child = Bun.spawn([process.execPath, fixturePath(fixture), ...argv], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const record: SpawnRecord = {
      argv,
      child,
      exitSettled: false,
      exitCode: null,
      signals: [],
    };
    records.push(record);
    // Attached before the runner awaits `exited`, so it observes the exit first.
    child.exited.then(
      (code) => {
        record.exitSettled = true;
        record.exitCode = code;
      },
      () => {
        record.exitSettled = true;
      },
    );
    return {
      exited: child.exited,
      kill: (signal) => {
        record.signals.push(signal ?? "SIGTERM");
        child.kill(signal);
      },
      stdout: child.stdout,
      stderr: child.stderr,
    };
  };
}

function runnerFor(
  records: SpawnRecord[],
  diagnostics: RunnerDiagnostics[],
  fixture: string,
  timeoutMs: number,
  onDiagnostics?: (diagnostics: RunnerDiagnostics) => void,
) {
  return createWakeRunner({
    spawn: fixtureSeam(records, fixture),
    timeoutMs,
    onDiagnostics: onDiagnostics ?? ((d) => diagnostics.push(d)),
  });
}

function resultKindsOnly(result: unknown): string[] {
  return Object.keys(result as object);
}

async function streamIsClosed(
  stream: ReadableStream<Uint8Array> | null,
): Promise<boolean> {
  if (!stream) {
    return true;
  }
  if (stream.locked) {
    return false;
  }
  const reader = stream.getReader();
  try {
    const next = await reader.read();
    return next.done === true;
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

describe("P05 runner — exact argv through the private seam", () => {
  test("the seam receives exactly the C3 argv with the literal executable", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const runner = runnerFor(records, diagnostics, "echo-argv.ts", 2000);

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });

    expect(records.length).toBe(1);
    const argv = records[0].argv;
    expect(argv.length).toBe(4);
    expect(argv[0]).toBe("wakeonlan");
    expect(argv[0]).toBe(WAKE_EXECUTABLE);
    expect(argv).toEqual([
      "wakeonlan",
      "-i",
      "192.168.1.255",
      "02:AA:BB:CC:DD:EE",
    ]);
    expect(result).toEqual({ kind: "ok" });

    // The fixture echoes its own argv as JSON: the values reached the child
    // intact, so nothing was shell-split, expanded, or added.
    const echoed = JSON.parse(diagnostics[0].text.trim()) as string[];
    expect(echoed).toEqual([...argv]);
  });

  test("a null override produces exactly the MAC-only argv, the CLI default path", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const runner = runnerFor(records, diagnostics, "echo-argv.ts", 2000);

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: null,
    });

    expect(records.length).toBe(1);
    const argv = records[0].argv;
    expect(argv.length).toBe(2);
    expect(argv[0]).toBe(WAKE_EXECUTABLE);
    expect(argv).toEqual(["wakeonlan", "02:AA:BB:CC:DD:EE"]);
    // Non-vacuity: neither `-i` nor any address is present, so no default was
    // substituted for the omitted override.
    expect(argv).not.toContain("-i");
    expect(result).toEqual({ kind: "ok" });

    const echoed = JSON.parse(diagnostics[0].text.trim()) as string[];
    expect(echoed).toEqual([...argv]);
  });

  test("an explicit device override still produces the exact -i argv", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const runner = runnerFor(records, diagnostics, "echo-argv.ts", 2000);

    await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "10.0.0.255",
    });
    await runner({ macAddress: "02:11:22:33:44:55", broadcastAddress: null });

    // Non-vacuity: the same runner instance produced both forms, so the argv is
    // chosen per call rather than fixed for the process.
    expect(records.map((record) => record.argv)).toEqual([
      ["wakeonlan", "-i", "10.0.0.255", "02:AA:BB:CC:DD:EE"],
      ["wakeonlan", "02:11:22:33:44:55"],
    ]);
  });

  test("shell metacharacters in the addresses are not expanded", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const runner = runnerFor(records, diagnostics, "echo-argv.ts", 2000);

    const broadcast = "127.0.0.1; echo pwned $HOME";
    const mac = "02:AA:BB:CC:DD:EE `id`";
    await runner({ macAddress: mac, broadcastAddress: broadcast });

    const echoed = JSON.parse(diagnostics[0].text.trim()) as string[];
    expect(echoed).toEqual(["wakeonlan", "-i", broadcast, mac]);
    expect(echoed.length).toBe(4);
  });

  test("the production timeout constant is the C3 five seconds", () => {
    expect(WAKE_COMMAND_TIMEOUT_MS).toBe(5000);
    expect(MAX_DIAGNOSTIC_BYTES).toBe(8192);
  });
});

describe("P05 runner — exit status from real subprocesses", () => {
  test("exit code 0 returns ok", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const runner = runnerFor(records, diagnostics, "echo-argv.ts", 2000);

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });

    expect(result).toEqual({ kind: "ok" });
    expect(diagnostics[0].exitCode).toBe(0);
    expect(diagnostics[0].timedOut).toBe(false);
    expect(diagnostics[0].error).toBeNull();
  });

  test("a nonzero exit returns failed", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const runner = runnerFor(records, diagnostics, "exit-nonzero.ts", 2000);

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });

    expect(result).toEqual({ kind: "failed" });
    expect(diagnostics[0].exitCode).toBe(3);
    expect(diagnostics[0].text).toContain("fixture: nonzero exit");
  });
});

describe("P05 runner — spawn failures never reject", () => {
  test("a synchronous spawn throw returns failed", async () => {
    const diagnostics: RunnerDiagnostics[] = [];
    const seam: SpawnCommand = () => {
      throw new Error('Executable not found in $PATH: "wakeonlan"');
    };
    const runner = createWakeRunner({
      spawn: seam,
      timeoutMs: 2000,
      onDiagnostics: (d) => diagnostics.push(d),
    });

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });

    expect(result).toEqual({ kind: "failed" });
    expect(diagnostics[0].exitCode).toBeNull();
    expect(diagnostics[0].error).toContain("Executable not found");
  });

  test("a rejected exit promise returns failed", async () => {
    const diagnostics: RunnerDiagnostics[] = [];
    const seam: SpawnCommand = () => ({
      exited: Promise.reject(new Error("spawn failed")),
      kill: () => {},
      stdout: null,
      stderr: null,
    });
    const runner = createWakeRunner({
      spawn: seam,
      timeoutMs: 2000,
      onDiagnostics: (d) => diagnostics.push(d),
    });

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });

    expect(result).toEqual({ kind: "failed" });
    expect(diagnostics[0].exitCode).toBeNull();
  });

  test("a throwing diagnostics callback does not reject the runner", async () => {
    const seam: SpawnCommand = () => ({
      exited: Promise.resolve(0),
      kill: () => {},
      stdout: null,
      stderr: null,
    });
    const runner = createWakeRunner({
      spawn: seam,
      timeoutMs: 2000,
      onDiagnostics: () => {
        throw new Error("logging failed");
      },
    });

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });
    expect(result).toEqual({ kind: "ok" });
  });
});

describe("P05 runner — timeout kills and waits for exit", () => {
  test("the deadline kills the child, waits for its exit, and returns timeout", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const deadline = 250;
    const runner = runnerFor(
      records,
      diagnostics,
      "sleep-until-killed.ts",
      deadline,
    );

    const started = Date.now();
    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "255.255.255.255",
    });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ kind: "timeout" });
    const record = records[0];
    expect(record.signals).toEqual(["SIGTERM"]);
    // The fixture handles SIGTERM and exits 0 after a short grace, so the runner
    // must have waited for the real exit rather than returning at the deadline,
    // and a zero exit code after a kill is still a timeout.
    expect(record.exitSettled).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(deadline);
    expect(elapsed).toBeLessThan(deadline + 3000);
    expect(diagnostics[0].timedOut).toBe(true);
    expect(diagnostics[0].text).toContain("received SIGTERM");
  });

  test("a child that exits before the deadline is never killed", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const runner = runnerFor(records, diagnostics, "echo-argv.ts", 200);

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });
    expect(result).toEqual({ kind: "ok" });

    // Wait past the deadline: a timer left running would kill the child here.
    await Bun.sleep(400);
    expect(records[0].signals).toEqual([]);
  });
});

describe("P05 runner — bounded combined capture and concurrent draining", () => {
  test("output beyond the budget is drained from both pipes without hanging", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    // Bun buffers a child's pipe writes, so the fixture can finish writing
    // without the parent reading. The run can only complete if both drains keep
    // reading past the capture budget to EOF, so a short deadline here proves
    // the pipes are drained concurrently rather than abandoned at the cap.
    const runner = runnerFor(records, diagnostics, "oversized-output.ts", 1500);

    const started = Date.now();
    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ kind: "ok" });
    expect(elapsed).toBeLessThan(1500);

    const diagnostics0 = diagnostics[0];
    expect(diagnostics0.bytesCaptured).toBeLessThanOrEqual(
      MAX_DIAGNOSTIC_BYTES,
    );
    expect(diagnostics0.bytesCaptured).toBe(MAX_DIAGNOSTIC_BYTES);
    expect(diagnostics0.truncated).toBe(true);
    expect(
      new TextEncoder().encode(diagnostics0.text).length,
    ).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES);
    // Both pipes contributed to the same combined capture, so both were drained.
    expect(diagnostics0.text).toContain("STDOUT-MARKER");
    expect(diagnostics0.text).toContain("STDERR-MARKER");

    // The drains must have read past the budget to EOF: a runner that stopped
    // reading once its budget was full would leave these streams open.
    const record = records[0];
    expect(await streamIsClosed(record.child.stdout)).toBe(true);
    expect(await streamIsClosed(record.child.stderr)).toBe(true);
  });

  test("a truncated chunk retains its own copy, not the source buffer", async () => {
    const diagnostics: RunnerDiagnostics[] = [];
    // A multi-megabyte backing buffer delivered as one oversized view: the
    // capture must copy the retained prefix so the large buffer is not kept alive.
    const backing = new Uint8Array(4 * 1024 * 1024).fill(0x41);
    // Larger than the budget, so the retained prefix is the truncated part.
    const view = backing.subarray(0, MAX_DIAGNOSTIC_BYTES * 2);
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(view);
          return;
        }
        // Runs after the capture has taken the chunk, so a retained view would
        // show this mutation in the reported text while a copy would not.
        backing.fill(0x42);
        controller.close();
      },
    });
    const seam: SpawnCommand = () => ({
      exited: Promise.resolve(0),
      kill: () => {},
      stdout: stream,
      stderr: null,
    });
    const runner = createWakeRunner({
      spawn: seam,
      timeoutMs: 1000,
      onDiagnostics: (d) => diagnostics.push(d),
    });

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "127.0.0.1",
    });

    expect(result).toEqual({ kind: "ok" });
    expect(diagnostics[0].bytesCaptured).toBe(MAX_DIAGNOSTIC_BYTES);
    expect(diagnostics[0].truncated).toBe(true);
    expect(diagnostics[0].text).toBe("A".repeat(MAX_DIAGNOSTIC_BYTES));
  });

  test("a retained chunk that is a view of a larger buffer is copied too", async () => {
    const diagnostics: RunnerDiagnostics[] = [];
    const backing = new Uint8Array(4 * 1024 * 1024).fill(0x41);
    const view = backing.subarray(1024, 1024 + 64);
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(view);
          return;
        }
        // Same ordering as above: the capture has already taken the chunk.
        backing.fill(0x42);
        controller.close();
      },
    });
    const seam: SpawnCommand = () => ({
      exited: Promise.resolve(0),
      kill: () => {},
      stdout: stream,
      stderr: null,
    });
    const runner = createWakeRunner({
      spawn: seam,
      timeoutMs: 1000,
      onDiagnostics: (d) => diagnostics.push(d),
    });

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "127.0.0.1",
    });

    expect(result).toEqual({ kind: "ok" });
    expect(diagnostics[0].bytesCaptured).toBe(64);
    expect(diagnostics[0].truncated).toBe(false);
    expect(diagnostics[0].text).toBe("A".repeat(64));
  });

  test("a stream that errors while draining does not reject the runner", async () => {
    const diagnostics: RunnerDiagnostics[] = [];
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream error"));
      },
    });
    const seam: SpawnCommand = () => ({
      exited: Promise.resolve(0),
      kill: () => {},
      stdout: failing,
      stderr: null,
    });
    const runner = createWakeRunner({
      spawn: seam,
      timeoutMs: 1000,
      onDiagnostics: (d) => diagnostics.push(d),
    });

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });

    expect(result).toEqual({ kind: "ok" });
    expect(diagnostics[0].bytesCaptured).toBe(0);
    // The failed read is caught and the reader released, so no reader is left
    // dangling on the errored stream.
    expect(failing.locked).toBe(false);
  });

  test("streams are closed after the run on every path", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const runner = runnerFor(records, diagnostics, "exit-nonzero.ts", 1000);

    await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });
    const record = records[0];
    expect(await streamIsClosed(record.child.stdout)).toBe(true);
    expect(await streamIsClosed(record.child.stderr)).toBe(true);
  });
});

describe("P05 runner — result shape", () => {
  test("results carry only the approved kind", async () => {
    const records: SpawnRecord[] = [];
    const diagnostics: RunnerDiagnostics[] = [];
    const runner = runnerFor(records, diagnostics, "exit-nonzero.ts", 1000);

    const result = await runner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });

    expect(resultKindsOnly(result)).toEqual(["kind"]);
    expect(["ok", "failed", "timeout"]).toContain(result.kind);
  });
});
