/**
 * P05 — C3 command runner (process handling only).
 *
 * Production runs the installed `wakeonlan` CLI with exactly
 * `["wakeonlan", macAddress]` when the device has no saved broadcast override,
 * and `["wakeonlan", "-i", broadcastAddress, macAddress]` when it does, with no
 * shell expansion, no subnet inference, and no hardcoded default address.
 * This module owns exit status, timeout termination, and bounded diagnostics;
 * validation, cooldown, and HTTP mapping live in other packets. The runner never
 * throws: every path returns one of the three C3 result kinds.
 *
 * The spawn seam is private to this module and its tests. It is not exposed
 * through the API or configuration, and no automated test may resolve or invoke
 * the real `wakeonlan` executable.
 */
import type { CommandResult, RunWakeCommand } from "../shared/contracts.js";

/** C3 production deadline. Tests inject a shorter one; this value is fixed. */
export const WAKE_COMMAND_TIMEOUT_MS = 5000;

/** Combined stdout + stderr diagnostic budget, in bytes. */
export const MAX_DIAGNOSTIC_BYTES = 8 * 1024;

/** Bounded length of a spawn-failure reason kept for internal logging. */
const MAX_ERROR_CHARS = 200;

export const WAKE_EXECUTABLE = "wakeonlan";

/**
 * Minimal subprocess shape the runner depends on. `Bun.spawn` satisfies it;
 * tests satisfy it through the injected seam with real test subprocesses.
 */
export interface SpawnedProcess {
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
}

/** Private spawn seam: production calls `Bun.spawn`, tests inject fixtures. */
export type SpawnCommand = (argv: readonly string[]) => SpawnedProcess;

/** Bounded internal diagnostic record. Never rendered into an HTTP error. */
export type RunnerDiagnostics = {
  argv: readonly string[];
  exitCode: number | null;
  timedOut: boolean;
  /** Combined output text, at most `MAX_DIAGNOSTIC_BYTES` bytes. */
  text: string;
  bytesCaptured: number;
  truncated: boolean;
  /** Bounded spawn failure reason, when the seam threw. */
  error: string | null;
};

export type RunnerOptions = {
  spawn?: SpawnCommand;
  timeoutMs?: number;
  onDiagnostics?: (diagnostics: RunnerDiagnostics) => void;
};

/**
 * Copy the bytes the capture keeps so a retained chunk never outlives its source.
 * `subarray` would keep the whole backing `ArrayBuffer` alive, so one multi-megabyte
 * stream chunk could retain far more than the diagnostic budget. A chunk that is
 * already exactly its own storage is kept as is; anything else is copied.
 */
function retainedCopy(chunk: Uint8Array, length: number): Uint8Array {
  if (
    length === chunk.length &&
    chunk.byteOffset === 0 &&
    chunk.buffer.byteLength === chunk.byteLength
  ) {
    return chunk;
  }
  return chunk.slice(0, length);
}

/** Bounded combined capture: excess is consumed and discarded, never buffered. */
class BoundedCapture {
  readonly #chunks: Uint8Array[] = [];
  #bytes = 0;
  #truncated = false;

  add(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }
    const remaining = MAX_DIAGNOSTIC_BYTES - this.#bytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    if (chunk.length > remaining) {
      this.#chunks.push(retainedCopy(chunk, remaining));
      this.#bytes += remaining;
      this.#truncated = true;
      return;
    }
    this.#chunks.push(retainedCopy(chunk, chunk.length));
    this.#bytes += chunk.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  text(): string {
    let combined: Uint8Array;
    if (this.#chunks.length === 1) {
      combined = this.#chunks[0];
    } else {
      combined = new Uint8Array(this.#bytes);
      let offset = 0;
      for (const chunk of this.#chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(combined);
  }
}

function boundedError(cause: unknown): string {
  const message =
    cause instanceof Error ? cause.message : String(cause ?? "unknown error");
  return message.length > MAX_ERROR_CHARS
    ? message.slice(0, MAX_ERROR_CHARS) + "…"
    : message;
}

/**
 * Drain one stream to EOF. Reading continues past the capture budget so the pipe
 * never blocks the child; only the retained copy is bounded. A stream that errors
 * or is cancelled is closed here and never rejects the runner.
 */
async function drain(
  stream: ReadableStream<Uint8Array> | null,
  capture: BoundedCapture,
): Promise<void> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      if (next.value) {
        capture.add(next.value);
      }
    }
  } catch {
    // The exit status decides the result, so a failed read is not a runner
    // failure; close the stream anyway so nothing is left open.
    try {
      await reader.cancel();
    } catch {
      // Already errored or closed.
    }
  } finally {
    reader.releaseLock();
  }
}

function defaultSpawn(argv: readonly string[]): SpawnedProcess {
  return Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
}

function logDiagnostics(diagnostics: RunnerDiagnostics): void {
  console.error(
    `wake command: ${diagnostics.argv.join(" ")} ` +
      `exit=${diagnostics.exitCode ?? "unknown"} timedOut=${diagnostics.timedOut} ` +
      `bytes=${diagnostics.bytesCaptured}${diagnostics.truncated ? " (truncated)" : ""}` +
      `${diagnostics.error ? ` error=${diagnostics.error}` : ""} ` +
      `output=${JSON.stringify(diagnostics.text)}`,
  );
}

/**
 * Build a `RunWakeCommand` for the wake service (P06). `timeoutMs` and the spawn
 * seam are injectable for tests; production uses the C3 defaults.
 */
export function createWakeRunner(options: RunnerOptions = {}): RunWakeCommand {
  const spawn = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? WAKE_COMMAND_TIMEOUT_MS;
  const onDiagnostics = options.onDiagnostics ?? logDiagnostics;

  return async function runWakeCommand({
    macAddress,
    broadcastAddress,
  }): Promise<CommandResult> {
    // Exact argv per `wol-cli-default-r2`: no override means the installed CLI's
    // own default, so the address is simply omitted rather than substituted.
    const argv =
      broadcastAddress === null
        ? [WAKE_EXECUTABLE, macAddress]
        : [WAKE_EXECUTABLE, "-i", broadcastAddress, macAddress];

    // Internal logging only: a throwing callback must not reject the runner.
    const report = (diagnostics: RunnerDiagnostics): void => {
      try {
        onDiagnostics(diagnostics);
      } catch {
        // Diagnostics are never returned to the caller, let alone an HTTP error.
      }
    };

    let child: SpawnedProcess;
    try {
      child = spawn(argv);
    } catch (cause) {
      report({
        argv,
        exitCode: null,
        timedOut: false,
        text: "",
        bytesCaptured: 0,
        truncated: false,
        error: boundedError(cause),
      });
      return { kind: "failed" };
    }

    const capture = new BoundedCapture();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The child already exited; the exit promise still settles.
      }
    }, timeoutMs);

    // Drain concurrently so a full pipe cannot block the child while we wait.
    const drains = [drain(child.stdout, capture), drain(child.stderr, capture)];

    let exitCode: number | null = null;
    try {
      exitCode = await child.exited;
    } catch {
      // Spawned process reported an execution error. Preserve `timedOut`: a kill
      // that makes the exit promise reject is still a timed-out run.
      exitCode = null;
    } finally {
      clearTimeout(timer);
    }

    // Bun closes the pipes when the child exits, so the drains settle on every
    // path, including the killed one. Wait for the readers so no read is left
    // dangling after the result is produced.
    await Promise.allSettled(drains);

    report({
      argv,
      exitCode,
      timedOut,
      text: capture.text(),
      bytesCaptured: capture.bytes,
      truncated: capture.truncated,
      error: null,
    });

    if (timedOut) {
      return { kind: "timeout" };
    }
    return exitCode === 0 ? { kind: "ok" } : { kind: "failed" };
  };
}
