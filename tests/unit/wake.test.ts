import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createWakeRunner } from "../../src/server/wake";

/**
 * The real subprocess adapter, pointed at a harmless fixture executable instead of the
 * installed CLI. Nothing here can wake LAN equipment, and no HTTP layer is involved.
 */
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "fake-wakeonlan.ts");

type FixtureOptions = {
  exitCode?: number;
  sleepMs?: number;
  timeoutMs?: number;
  stderr?: string;
  log?: (message: string) => void;
};

function runner(markerDir: string, fixture: FixtureOptions = {}) {
  return createWakeRunner({
    executable: FIXTURE,
    timeoutMs: fixture.timeoutMs ?? 5000,
    log: fixture.log ?? (() => {}),
    spawn: (argv, options) =>
      Bun.spawn(argv, {
        ...options,
        env: {
          ...process.env,
          FAKE_WAKE_MARKER_DIR: markerDir,
          FAKE_WAKE_EXIT: String(fixture.exitCode ?? 0),
          FAKE_WAKE_SLEEP_MS: String(fixture.sleepMs ?? 0),
          ...(fixture.stderr ? { FAKE_WAKE_STDERR: fixture.stderr } : {}),
        },
      }),
  });
}

function recordedArgv(markerDir: string): string[] {
  return JSON.parse(readFileSync(join(markerDir, "argv.json"), "utf8")) as string[];
}

describe("C4 subprocess adapter", () => {
  test("the canonical MAC is exactly the second argument after the executable", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "wol-wake-"));
    const outcome = await runner(markerDir)("C8:53:09:F8:8A:32");

    expect(outcome).toEqual({ status: "sent" });
    expect(recordedArgv(markerDir)).toEqual([FIXTURE, "C8:53:09:F8:8A:32"]);
  });

  test("no shell is involved: a shell-looking argument stays a single argv element", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "wol-wake-"));
    const injected = "C8:53:09:F8:8A:32; touch /tmp/wol-pwned";
    const outcome = await runner(markerDir)(injected);

    expect(outcome).toEqual({ status: "sent" });
    expect(recordedArgv(markerDir)).toEqual([FIXTURE, injected]);
    expect(existsSync("/tmp/wol-pwned")).toBe(false);
  });

  test("a nonzero exit is a failure with the exit code", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "wol-wake-"));
    const logged: string[] = [];
    const outcome = await runner(markerDir, {
      exitCode: 7,
      stderr: "device unreachable\n",
      log: (message) => logged.push(message),
    })("C8:53:09:F8:8A:32");

    expect(outcome).toEqual({ status: "failed", exitCode: 7 });
    expect(logged.join(" ")).toContain("exited 7");
  });

  test("a missing executable is reported as unavailable", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "wol-wake-"));
    const missing = join(markerDir, "definitely-not-installed");
    const outcome = await createWakeRunner({ executable: missing, log: () => {} })(
      "C8:53:09:F8:8A:32",
    );

    expect(outcome).toEqual({ status: "unavailable" });
  });

  test("a hanging child is killed, reaped, and reported as a timeout", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "wol-wake-"));
    const outcome = await runner(markerDir, { sleepMs: 3000, timeoutMs: 200 })("C8:53:09:F8:8A:32");

    expect(outcome).toEqual({ status: "timeout" });
    // The adapter awaited the child after killing it, so the reap already happened.
    expect(existsSync(join(markerDir, "terminated.txt"))).toBe(true);
  });

  test("a fast child resolves before the bound, so the timer never gates success", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "wol-wake-"));
    const started = Date.now();
    const outcome = await runner(markerDir, { timeoutMs: 5000 })("C8:53:09:F8:8A:32");

    expect(outcome).toEqual({ status: "sent" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("captured output is bounded", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "wol-wake-"));
    const logged: string[] = [];
    const noisy = "x".repeat(20000);
    await runner(markerDir, {
      exitCode: 1,
      stderr: noisy,
      log: (message) => logged.push(message),
    })("C8:53:09:F8:8A:32");

    const captured = logged.join(" ");
    expect(captured.length).toBeLessThanOrEqual(4136);
    expect(captured).toContain("x".repeat(100));
  });
});
