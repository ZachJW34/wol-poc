/**
 * C4 — bounded subprocess adapter for the installed `wakeonlan` CLI.
 *
 * argv is always `[executable, mac]`: no shell, no `sh -c`, no command-string
 * interpolation, and no request-supplied executable, broadcast address, or extra
 * arguments. The executable is injectable only so tests can point at a harmless
 * fixture instead of waking real LAN equipment.
 */

export type WakeOutcome =
  | { status: "sent" }
  | { status: "failed"; exitCode: number | null }
  | { status: "unavailable" }
  | { status: "timeout" };

/** Minimal shape Bun.spawn satisfies; keeps the adapter testable without a shell. */
export type ChildLike = {
  exited: Promise<number | null>;
  kill: () => void;
  stderr?: ReadableStream<Uint8Array> | null;
};

/** The adapter owns the output policy: nothing is buffered without bound. */
export type SpawnOptions = { stdout: "ignore"; stderr: "pipe" };

export type WakeDeps = {
  spawn?: (argv: string[], options: SpawnOptions) => ChildLike;
  executable?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
};

export type WakeRunner = (mac: string) => Promise<WakeOutcome>;

export const WAKE_TIMEOUT_MS = 5000;
const STDERR_CAP = 4096;
const OUTPUT: SpawnOptions = { stdout: "ignore", stderr: "pipe" };

export function createWakeRunner(deps: WakeDeps = {}): WakeRunner {
  const spawn = deps.spawn ?? defaultSpawn;
  const executable = deps.executable ?? "wakeonlan";
  const timeoutMs = deps.timeoutMs ?? WAKE_TIMEOUT_MS;
  const log = deps.log ?? ((message: string) => console.error(`[wake] ${message}`));

  return async function wake(mac: string): Promise<WakeOutcome> {
    const argv = [executable, mac];

    let child: ChildLike;
    try {
      child = spawn(argv, OUTPUT);
    } catch (error) {
      if (isMissingExecutable(error)) {
        log(`wake command is not available on this host`);
        return { status: "unavailable" };
      }
      log(`could not start wake command: ${brief(error)}`);
      return { status: "failed", exitCode: null };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    // Output is drained with a hard cap; nothing is buffered without bound.
    const draining = drain(child.stderr);

    try {
      const exitCode = await Promise.race([child.exited, timedOut]);

      if (exitCode === "timeout") {
        child.kill();
        await child.exited; // reap the timed-out child
        log(`wake command timed out after ${timeoutMs}ms`);
        return { status: "timeout" };
      }

      const stderr = await draining;
      if (exitCode === 0) return { status: "sent" };

      log(`wake command exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`);
      return { status: "failed", exitCode };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

function defaultSpawn(argv: string[], options: SpawnOptions): ChildLike {
  const child = Bun.spawn(argv, options);
  return { exited: child.exited, kill: () => child.kill(), stderr: child.stderr };
}

async function drain(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";

  const decoder = new TextDecoder();
  let text = "";
  const reader = stream.getReader();
  try {
    while (text.length < STDERR_CAP) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    // A stream that fails mid-drain is a diagnostic detail, not a wake failure.
  } finally {
    reader.releaseLock();
  }

  return text.slice(0, STDERR_CAP);
}

function isMissingExecutable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "ENOENT") return true;
  return error instanceof Error && error.message.includes("ENOENT");
}

/** Concise server-side diagnostic only; never a raw subprocess object. */
function brief(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}
