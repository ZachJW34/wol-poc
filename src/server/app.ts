import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ERROR_CODES, validateDeviceInput } from "../shared/contracts";
import type { Device, DeviceInput } from "../shared/contracts";
import { HttpError } from "./errors";
import type { DeviceStore } from "./store";
import type { WakeRunner } from "./wake";

/**
 * C3 — the request handler, assembled from explicit dependencies so tests can inject
 * harmless ones. Importing this module starts no listener and emits no packets.
 */

/** `Bun.file()` returns a lazy file handle; `Blob` is the response-body shape it satisfies. */
export type StaticEntry = { file: Blob; type: string };
export type StaticMap = Map<string, StaticEntry>;

export type AppDeps = {
  store: DeviceStore;
  wake: WakeRunner;
  appOrigin: string;
  staticMap: StaticMap;
  log?: (message: string) => void;
};

/** Explicit allowlist: only built assets with a known type can ever be served. */
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function buildStaticMap(distDir: string): StaticMap {
  const map: StaticMap = new Map();
  if (!existsSync(distDir)) return map;

  for (const entry of walk(distDir)) {
    const name = entry.name;
    if (name.startsWith(".")) continue; // hidden files
    if (name.endsWith(".map")) continue; // sourcemaps

    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const type = STATIC_TYPES[name.slice(dot).toLowerCase()];
    if (!type) continue;

    map.set(`/${entry.relative}`, { file: Bun.file(entry.path), type });
  }

  const index = map.get("/index.html");
  if (index) map.set("/", index);

  return map;
}

function walk(dir: string, prefix = ""): Array<{ name: string; relative: string; path: string }> {
  const found: Array<{ name: string; relative: string; path: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(path).isDirectory()) found.push(...walk(path, relative));
    else found.push({ name, relative, path });
  }
  return found;
}

export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? ((message: string) => console.error(`[api] ${message}`));
  const waking = new Set<string>();

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await api(request, url);
      } catch (error) {
        if (error instanceof HttpError) return failure(request, error);
        log(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
        return failure(
          request,
          new HttpError(ERROR_CODES.INTERNAL_ERROR, 500, "Unexpected server error."),
        );
      }
    }

    return staticResponse(url.pathname);
  };

  async function api(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (path === "/api/health") {
      if (method !== "GET") return failure(request, methodNotAllowed());
      return json(200, { ok: true });
    }

    if (path === "/api/devices") {
      if (method === "GET") return json(200, { devices: deps.store.list() });
      if (method === "POST") {
        const input = await readInput(request);
        return json(201, { device: deps.store.create(input) });
      }
      return failure(request, methodNotAllowed());
    }

    const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(path);
    if (deviceMatch) {
      const id = deviceMatch[1]!;
      if (method === "PATCH") {
        const input = await readInput(request);
        const device = deps.store.update(id, input);
        if (!device) return failure(request, notFound());
        return json(200, { device });
      }
      if (method === "DELETE") {
        requireOrigin(request);
        if (!deps.store.remove(id)) return failure(request, notFound());
        return new Response(null, { status: 204, headers: noStore() });
      }
      return failure(request, methodNotAllowed());
    }

    const wakeMatch = /^\/api\/devices\/([^/]+)\/wake$/.exec(path);
    if (wakeMatch) {
      if (method === "POST") return wake(request, wakeMatch[1]!);
      return failure(request, methodNotAllowed());
    }

    // Unknown API routes are JSON 404, never the SPA HTML.
    return failure(request, new HttpError(ERROR_CODES.NOT_FOUND, 404, "Unknown API route."));
  }

  async function wake(request: Request, id: string): Promise<Response> {
    requireOrigin(request);
    requireJsonContentType(request);

    const body = await readJson(request);
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0
    ) {
      throw new HttpError(
        ERROR_CODES.VALIDATION_ERROR,
        400,
        "Wake body must be an empty JSON object.",
      );
    }

    // Resolve the snapshot before spawning; nothing here accepts a MAC or command.
    const device = deps.store.get(id);
    if (!device) return failure(request, notFound());

    if (waking.has(id)) {
      return failure(
        request,
        new HttpError(
          ERROR_CODES.WAKE_IN_PROGRESS,
          409,
          "A wake for this device is already running.",
        ),
      );
    }

    waking.add(id);
    try {
      const outcome = await deps.wake(device.mac);
      switch (outcome.status) {
        case "sent":
          return json(200, { status: "sent", deviceId: device.id });
        case "unavailable":
          return failure(
            request,
            new HttpError(
              ERROR_CODES.WAKE_UNAVAILABLE,
              503,
              "Wake command is not available on the server.",
            ),
          );
        case "timeout":
          return failure(
            request,
            new HttpError(ERROR_CODES.WAKE_TIMEOUT, 504, "Wake command timed out."),
          );
        default:
          return failure(
            request,
            new HttpError(ERROR_CODES.WAKE_FAILED, 502, "Wake command failed."),
          );
      }
    } finally {
      waking.delete(id);
    }
  }

  async function readInput(request: Request): Promise<DeviceInput> {
    requireOrigin(request);
    requireJsonContentType(request);

    const body = await readJson(request);
    const result = validateDeviceInput(body);
    if (!result.ok) {
      throw new HttpError(
        ERROR_CODES.VALIDATION_ERROR,
        400,
        "Invalid device input.",
        result.fields,
      );
    }
    return result.input;
  }

  async function readJson(request: Request): Promise<unknown> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new HttpError(ERROR_CODES.INVALID_JSON, 400, "Request body must be valid JSON.");
    }
    return body;
  }

  function requireOrigin(request: Request): void {
    const origin = request.headers.get("origin");
    if (origin !== deps.appOrigin) {
      throw new HttpError(
        ERROR_CODES.FORBIDDEN_ORIGIN,
        403,
        "Origin does not match the configured APP_ORIGIN.",
      );
    }
  }

  function requireJsonContentType(request: Request): void {
    const mediaType = (request.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      throw new HttpError(
        ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        415,
        "Content-Type must be application/json.",
      );
    }
  }

  function methodNotAllowed(): HttpError {
    return new HttpError(ERROR_CODES.METHOD_NOT_ALLOWED, 405, "Unsupported method for this route.");
  }

  function notFound(): HttpError {
    return new HttpError(ERROR_CODES.NOT_FOUND, 404, "Device not found.");
  }

  function noStore(): Record<string, string> {
    return { "cache-control": "no-store" };
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...noStore(), "content-type": "application/json; charset=utf-8" },
    });
  }

  function failure(request: Request, error: HttpError): Response {
    const envelope = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields && Object.keys(error.fields).length > 0 ? { fields: error.fields } : {}),
      },
    };
    return json(error.status, envelope);
  }

  function staticResponse(pathname: string): Response {
    const entry = deps.staticMap.get(pathname);
    if (!entry) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(entry.file, { headers: { "content-type": entry.type } });
  }
}
