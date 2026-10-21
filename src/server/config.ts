/**
 * C5 — configuration and trust boundary.
 *
 * Only the documented variables are read. Legacy `HOST`, broadcast, and per-device
 * override settings are deliberately ignored. Errors are actionable and never echo
 * secrets.
 */

export type NodeEnv = "development" | "production" | "test";

export type AppConfig = {
  env: NodeEnv;
  port: number;
  /** Fixed loopback bind; never configurable. */
  bind: "127.0.0.1";
  /** Canonical `new URL(value).origin`. */
  appOrigin: string;
  databasePath: string;
};

export class ConfigError extends Error {}

const DEFAULT_PORT = 7123;
const DEFAULT_DATABASE_PATH = "./data/wol.sqlite";
const DEV_DEFAULT_ORIGIN = "http://localhost:5173";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const env = parseEnv(source.NODE_ENV);
  const port = parsePort(source.PORT);
  const appOrigin = parseOrigin(source.APP_ORIGIN, env);
  const databasePath = (source.DATABASE_PATH ?? DEFAULT_DATABASE_PATH).trim();
  if (!databasePath) throw new ConfigError("DATABASE_PATH must not be empty.");

  return { env, port, bind: "127.0.0.1", appOrigin, databasePath };
}

function parseEnv(value: string | undefined): NodeEnv {
  if (value === undefined || value.trim() === "") return "production";
  const normalized = value.trim();
  if (normalized !== "development" && normalized !== "production" && normalized !== "test") {
    throw new ConfigError("NODE_ENV must be development, production, or test.");
  }
  return normalized;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) throw new ConfigError("PORT must be an integer between 1 and 65535.");
  const port = Number(raw);
  if (port < 1 || port > 65535)
    throw new ConfigError("PORT must be an integer between 1 and 65535.");
  return port;
}

function parseOrigin(value: string | undefined, env: NodeEnv): string {
  if (value === undefined || value.trim() === "") {
    if (env === "development") return DEV_DEFAULT_ORIGIN;
    throw new ConfigError(
      "APP_ORIGIN is required. Set it to the exact HTTPS origin reported by `tailscale serve status`.",
    );
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigError(
      "APP_ORIGIN must be an absolute URL, for example https://hostname.ts.net.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("APP_ORIGIN must use http: or https:.");
  }
  if (url.username || url.password)
    throw new ConfigError("APP_ORIGIN must not contain credentials.");
  if (url.pathname !== "/" && url.pathname !== "")
    throw new ConfigError("APP_ORIGIN must not contain a path.");
  if (url.search) throw new ConfigError("APP_ORIGIN must not contain a query.");
  if (url.hash) throw new ConfigError("APP_ORIGIN must not contain a fragment.");

  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new ConfigError("APP_ORIGIN may use HTTP only for a literal loopback origin.");
  }
  if (env === "test" && !loopback) {
    throw new ConfigError("APP_ORIGIN must be a loopback origin for test fixtures.");
  }

  return url.origin;
}
