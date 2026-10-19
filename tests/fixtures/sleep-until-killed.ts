/**
 * P05 test fixture: harmless subprocess that prints one line, then sleeps far
 * longer than any injected test deadline so the runner must kill it.
 *
 * It handles SIGTERM instead of dying immediately: it reports the signal and
 * exits 100 ms later with code 0. That lets the test prove the runner waits for
 * the real exit, and that a timed-out run is still reported as `timeout` even
 * when the exit code is zero.
 */
export {};

process.stdout.write("fixture: sleeping until killed\n");

process.on("SIGTERM", () => {
  process.stderr.write("fixture: received SIGTERM\n");
  setTimeout(() => process.exit(0), 100);
});

await Bun.sleep(30_000);
process.exit(0);
