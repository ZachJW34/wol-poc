#!/usr/bin/env bun
/**
 * Harmless stand-in for the `wakeonlan` CLI. It never sends a packet.
 *
 * It records the argv it was launched with, optionally writes stderr, optionally
 * sleeps, then exits with a requested code. A SIGTERM handler records that a
 * timed-out child was terminated and reaped.
 */
import { join } from "node:path";

const markerDir = process.env.FAKE_WAKE_MARKER_DIR;
if (!markerDir) {
  process.stderr.write("FAKE_WAKE_MARKER_DIR is required\n");
  process.exit(2);
}

const argv = process.argv.slice(1);
await Bun.write(join(markerDir, "argv.json"), JSON.stringify(argv));

if (process.env.FAKE_WAKE_STDERR) {
  await Bun.write(Bun.stderr, process.env.FAKE_WAKE_STDERR);
}

process.on("SIGTERM", async () => {
  await Bun.write(join(markerDir, "terminated.txt"), "terminated");
  process.exit(0);
});

const sleepMs = Number(process.env.FAKE_WAKE_SLEEP_MS ?? 0);
if (sleepMs > 0) await Bun.sleep(sleepMs);

process.exit(Number(process.env.FAKE_WAKE_EXIT ?? 0));
