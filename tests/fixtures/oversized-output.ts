/**
 * P05 test fixture: harmless subprocess that writes far more than the runner's
 * 8 KiB combined diagnostic budget on both pipes, then exits 0.
 *
 * Each pipe marks its own stream first, then the padding is written in small
 * paced chunks alternating between the two pipes. A runner that reads only one
 * pipe, or stops reading once its budget is full, cannot see both markers and
 * never reaches EOF.
 */
export {};

process.stdout.write("STDOUT-MARKER\n");
process.stderr.write("STDERR-MARKER\n");

const chunk = "x".repeat(1024);
for (let i = 0; i < 64; i += 1) {
  process.stdout.write(chunk);
  process.stderr.write(chunk);
  await Bun.sleep(5);
}
process.exit(0);
