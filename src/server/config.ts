/**
 * P02 environment configuration (handoff section 2), plus the P08 executable
 * availability probe.
 *
 * `loadConfig` validates configuration only and performs no filesystem access,
 * so a configuration failure is reported before anything is opened or listened
 * on. P08 adds PATH resolution for the installed wake CLI: the probe inspects
 * PATH and never executes the CLI, so no automated run can send a magic packet.
 * Invalid configuration and a missing executable must both fail production
 * startup actionably before the store is opened or the server listens.
 *
 * Under `wol-cli-default-r2` there is no global broadcast setting: nothing here
 * reads `WOL_BROADCAST_ADDRESS`, so a value left in an old environment file is
 * inert even when invalid. Devices delegate to the installed CLI's own default
 * unless a saved per-device override is present.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import { WAKE_EXECUTABLE } from "./runner.js";

/**
 * Loopback-only binding is required in every mode: the approved access path is
 * the existing private Tailscale proxy forwarding to a loopback backend, and the
 * automated test harness uses a loopback test origin. Production additionally
 * requires an HTTPS `APP_ORIGIN`; loopback HTTP is accepted only for an explicit
 * development/test configuration.
 */
export type ConfigMode = "production" | "development" | "test";

export type AppConfig = {
  mode: ConfigMode;
  host: string;
  port: number;
  appOrigin: string;
  databasePath: string;
  /** Served static assets root; the only directory static responses may read. */
  staticRoot: string;
};

/** Actionable configuration failure, reported before the store is opened or the server listens. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * P08 executable availability probe: return the resolved path of the installed
 * wake CLI, or `null` when it is not available. Existence and access only — a
 * probe must never execute the CLI.
 */
export type ExecutableProbe = (
  env: Record<string, string | undefined>,
) => string | null;

/** Default probe: scan PATH entries for an executable regular file. */
export function defaultExecutableProbe(
  env: Record<string, string | undefined>,
): string | null {
  const pathValue = env.PATH;
  if (pathValue === undefined || pathValue === "") {
    return null;
  }
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, WAKE_EXECUTABLE);
    try {
      if (!statSync(candidate).isFile()) {
        continue;
      }
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * Resolve the CLI for production startup. Tests inject a probe or a controlled
 * PATH; nothing here runs the executable. A missing CLI fails startup with an
 * actionable message before the store is opened or the server listens.
 */
export function resolveWakeExecutable(
  env: Record<string, string | undefined>,
  probe: ExecutableProbe = defaultExecutableProbe,
): string {
  const resolved = probe(env);
  if (resolved === null) {
    throw new ConfigError(
      `The wake CLI "${WAKE_EXECUTABLE}" is not available on PATH. Install it or add its directory to the service PATH; the startup check inspects PATH only and never runs the executable.`,
    );
  }
  return resolved;
}

const DEFAULTS = {
  host: "127.0.0.1",
  port: 3000,
  databasePath: "./data/wol.sqlite",
  staticRoot: "dist",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const LOOPBACK_ORIGIN_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function loadConfig(
  env: Record<string, string | undefined>,
  options: { mode: ConfigMode },
): AppConfig {
  const mode = options.mode;
  const cwd = process.cwd();
  const staticRoot = resolve(cwd, DEFAULTS.staticRoot);

  return {
    mode,
    host: parseHost(env.HOST, mode),
    port: parsePort(env.PORT),
    appOrigin: parseOrigin(env.APP_ORIGIN, mode),
    databasePath: parseDatabasePath(env.DATABASE_PATH, cwd, staticRoot),
    staticRoot,
  };
}

function parseHost(value: string | undefined, mode: ConfigMode): string {
  const host = value === undefined || value === "" ? DEFAULTS.host : value;
  if (!isIpLiteral(host)) {
    throw new ConfigError(
      `HOST must be an IP literal (IPv4 or IPv6); got "${host}". The app is reached through the existing private proxy, so it binds loopback only.`,
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      `HOST must be 127.0.0.1 or ::1 (the approved proxy forwards to a loopback backend); got "${host}" (${mode} configuration).`,
    );
  }
  return host;
}

function parsePort(value: string | undefined): number {
  const raw =
    value === undefined || value === "" ? String(DEFAULTS.port) : value;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(
      `PORT must be an integer between 1 and 65535; got "${raw}".`,
    );
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be between 1 and 65535; got ${port}.`);
  }
  return port;
}

function parseOrigin(value: string | undefined, mode: ConfigMode): string {
  if (value === undefined || value === "") {
    throw new ConfigError(
      "APP_ORIGIN is required: the single origin-only URL the browser uses (for example https://wol.tailnet.example, or http://127.0.0.1:3000 for an explicit development/test configuration).",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `APP_ORIGIN must be one origin-only URL with no path, query, fragment, or credentials; got "${value}".`,
    );
  }
  if (url.username || url.password) {
    throw new ConfigError(
      `APP_ORIGIN must not contain credentials; got "${value}".`,
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConfigError(
      `APP_ORIGIN must not contain a path; got "${value}".`,
    );
  }
  if (url.search || url.hash) {
    throw new ConfigError(
      `APP_ORIGIN must not contain a query or fragment; got "${value}".`,
    );
  }
  if (url.protocol === "https:") {
    return url.origin;
  }
  if (url.protocol === "http:") {
    if (mode === "production") {
      throw new ConfigError(
        `APP_ORIGIN must be an HTTPS origin in production; got "${value}". Loopback HTTP origins are accepted only for an explicit development/test configuration.`,
      );
    }
    if (!LOOPBACK_ORIGIN_HOSTS.has(url.hostname)) {
      throw new ConfigError(
        `A development/test HTTP APP_ORIGIN must be a loopback origin; got "${value}".`,
      );
    }
    return url.origin;
  }
  throw new ConfigError(
    `APP_ORIGIN must be an https (or loopback http for development/test) origin; got "${value}".`,
  );
}

function parseDatabasePath(
  value: string | undefined,
  cwd: string,
  staticRoot: string,
): string {
  const raw =
    value === undefined || value === "" ? DEFAULTS.databasePath : value;
  const path = resolve(cwd, raw);
  if (path === staticRoot || path.startsWith(staticRoot + sep)) {
    throw new ConfigError(
      `DATABASE_PATH must not be inside the served static assets (${staticRoot}); got "${raw}". Use a persistent data directory, for example ./data/wol.sqlite.`,
    );
  }
  return path;
}

function isIpLiteral(value: string): boolean {
  if (/^\d+(\.\d+){3}$/.test(value)) {
    return value.split(".").every((octet) => Number(octet) <= 255);
  }
  // IPv6 literal, optionally bracketed as in a URL host.
  const bare =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!bare.includes(":")) {
    return false;
  }
  const groups = bare.split(":");
  if (groups.length < 3 || groups.length > 8) {
    return false;
  }
  return groups.every(
    (group) => /^[0-9a-fA-F]{1,4}$/.test(group) || group === "",
  );
}
