/**
 * P04 injectable Request -> Response composition (C2 HTTP boundary).
 *
 * The handler is composed from dependencies so later packets can add the wake
 * service (P06) without changing the shape of the composition. P04 connects the
 * SQLite device repository (C1) to the collection and resource routes, adds the
 * mutation origin check, the JSON content-type and actual-byte body limits, and
 * the injectable busy predicate. P06 adds the wake route and supplies
 * `wake.isBusy` for the edit/delete busy gate.
 *
 * No CORS headers are emitted: access stays private through the existing
 * Tailscale authorization, and every mutation requires an `Origin` equal to the
 * configured `APP_ORIGIN`.
 */
import { statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import {
  ApplicationError,
  ERROR_STATUS,
  errorEnvelope,
  retryAfterSeconds,
  type CreateDevice,
  type UpdateDevice,
} from "../shared/contracts";
import { readBodyBytes, readJsonBody, requireOrigin } from "./http";
import type { DeviceRepository } from "./devices";
import type { WakeService } from "./wake";

export type AppDependencies = {
  /** Persistent device store (C1). P04 replaces the P02 injected list with it. */
  repository: DeviceRepository;
  /** The single configured origin mutations must come from (C2). */
  appOrigin: string;
  /**
   * Per-device busy predicate protecting edit and delete. Defaults to false;
   * P06 supplies `wake.isBusy`. Create and list are never gated by it.
   */
  isBusy?: (id: string) => boolean;
  /**
   * C3 wake service for `POST /api/devices/:id/wake`. When it is not composed,
   * the wake path stays an unknown JSON 404; the composition root always
   * supplies it for production.
   */
  wake?: WakeService;
  /** Absolute path of the only directory static responses may read: the Vite build. */
  staticRoot: string;
};

export type RequestHandler = (request: Request) => Promise<Response>;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createApp(deps: AppDependencies): RequestHandler {
  // P06 supplies `wake.isBusy`; an explicit predicate still wins, and the
  // default stays false when neither is composed.
  const isBusy = deps.isBusy ?? deps.wake?.isBusy ?? (() => false);
  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, url, deps, isBusy);
    }
    return serveStatic(request, url, deps.staticRoot);
  };
}

async function handleApi(
  request: Request,
  url: URL,
  deps: AppDependencies,
  isBusy: (id: string) => boolean,
): Promise<Response> {
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments[1] !== "devices") {
    return errorResponse(
      new ApplicationError("NOT_FOUND", "Unknown API route."),
    );
  }
  if (segments.length === 2) {
    return handleCollection(request, deps);
  }
  if (segments.length === 3) {
    return handleResource(request, segments[2], deps, isBusy);
  }
  // P06 wake route. Without a composed wake service the path stays an unknown
  // JSON 404; any deeper path is an unknown route.
  if (
    segments.length === 4 &&
    segments[3] === "wake" &&
    deps.wake !== undefined
  ) {
    return handleWake(request, segments[2], deps, deps.wake);
  }
  return errorResponse(new ApplicationError("NOT_FOUND", "Unknown API route."));
}

async function handleCollection(
  request: Request,
  deps: AppDependencies,
): Promise<Response> {
  if (request.method === "GET") {
    try {
      return jsonResponse(200, { devices: deps.repository.list() });
    } catch (error) {
      return errorResponse(toError(error, "Device list failed."));
    }
  }
  if (request.method === "POST") {
    try {
      requireOrigin(request, deps.appOrigin);
      const input = await readJsonBody(request);
      return jsonResponse(201, {
        device: deps.repository.create(input as CreateDevice),
      });
    } catch (error) {
      return errorResponse(toError(error, "Device operation failed."));
    }
  }
  return errorResponse(
    new ApplicationError(
      "METHOD_NOT_ALLOWED",
      "The device collection supports GET and POST.",
    ),
    { allow: "GET, POST" },
  );
}

async function handleResource(
  request: Request,
  id: string,
  deps: AppDependencies,
  isBusy: (id: string) => boolean,
): Promise<Response> {
  if (request.method === "PATCH") {
    try {
      requireOrigin(request, deps.appOrigin);
      if (isBusy(id)) {
        return busyResponse();
      }
      const input = await readJsonBody(request);
      return jsonResponse(200, {
        device: deps.repository.update(id, input as UpdateDevice),
      });
    } catch (error) {
      return errorResponse(toError(error, "Device operation failed."));
    }
  }
  if (request.method === "DELETE") {
    try {
      requireOrigin(request, deps.appOrigin);
      if (isBusy(id)) {
        return busyResponse();
      }
      // Delete has no body contract: an empty body is accepted, a nonempty one
      // is rejected, and the same actual-byte limit still applies.
      const body = await readBodyBytes(request);
      if (body.length > 0) {
        throw new ApplicationError(
          "VALIDATION_ERROR",
          "DELETE does not accept a request body.",
        );
      }
      deps.repository.delete(id);
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      return errorResponse(toError(error, "Device operation failed."));
    }
  }
  return errorResponse(
    new ApplicationError(
      "METHOD_NOT_ALLOWED",
      "The device resource supports PATCH and DELETE.",
    ),
    { allow: "PATCH, DELETE" },
  );
}

/**
 * P06 `POST /api/devices/:id/wake`. The origin check and the actual-byte body
 * limit run before the wake service, so a rejected request never reserves a
 * per-device slot. Wake has no body contract: an empty body is accepted and a
 * nonempty one is rejected.
 */
async function handleWake(
  request: Request,
  id: string,
  deps: AppDependencies,
  wake: WakeService,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(
      new ApplicationError("METHOD_NOT_ALLOWED", "Wake supports POST only."),
      { allow: "POST" },
    );
  }
  try {
    requireOrigin(request, deps.appOrigin);
    const body = await readBodyBytes(request);
    if (body.length > 0) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Wake does not accept a request body.",
      );
    }
    return jsonResponse(200, {
      device: await wake.wake(id),
      message: "Wake packet sent",
    });
  } catch (error) {
    return errorResponse(toError(error, "Wake failed."));
  }
}

function busyResponse(): Response {
  return errorResponse(new ApplicationError("CONFLICT", "Device is busy."));
}

/** Map an unknown failure to a sanitized application error; keep known codes. */
function toError(error: unknown, fallbackMessage: string): ApplicationError {
  return error instanceof ApplicationError
    ? error
    : new ApplicationError("INTERNAL_ERROR", fallbackMessage);
}

async function serveStatic(
  request: Request,
  url: URL,
  staticRoot: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      new ApplicationError(
        "METHOD_NOT_ALLOWED",
        "Static assets support GET and HEAD only.",
      ),
      { allow: "GET, HEAD" },
    );
  }

  const target = resolveStaticTarget(url.pathname, staticRoot);
  if (target === null) {
    return staticNotFound();
  }

  let stats;
  try {
    stats = statSync(target);
  } catch {
    return staticNotFound();
  }
  if (!stats.isFile()) {
    return staticNotFound();
  }

  // A link inside the build must not resolve outside the served root.
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = realpathSync(target);
    realRoot = realpathSync(staticRoot);
  } catch {
    return staticNotFound();
  }
  if (realTarget === realRoot || !realTarget.startsWith(realRoot + sep)) {
    return staticNotFound();
  }

  const headers: Record<string, string> = {
    "content-type": MIME_TYPES[extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  };
  return new Response(request.method === "HEAD" ? null : Bun.file(target), {
    headers,
  });
}

/**
 * Resolve a request path inside the static root only. Percent-decoded traversal
 * (`..`, `.`), dotfiles, encoded separators, and any target outside the root are
 * denied; there is no catch-all SPA HTML fallback because the app has no
 * client-side routes.
 */
function resolveStaticTarget(
  pathname: string,
  staticRoot: string,
): string | null {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return join(staticRoot, "index.html");
  }

  const decoded: string[] = [];
  for (const segment of segments) {
    let part: string;
    try {
      part = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (part === "." || part === "..") {
      return null;
    }
    if (
      part.startsWith(".") ||
      part.includes("/") ||
      part.includes("\\") ||
      part.includes("\0")
    ) {
      return null;
    }
    decoded.push(part);
  }

  const target = resolve(staticRoot, decoded.join("/"));
  if (target === staticRoot || !target.startsWith(staticRoot + sep)) {
    return null;
  }
  return target;
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function errorResponse(
  error: ApplicationError,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = { ...extraHeaders };
  // C2: a 429 carries `retryAfterMs` in the JSON error and a whole-seconds
  // `Retry-After` header rounded up from the same value.
  if (error.code === "WAKE_COOLDOWN" && error.retryAfterMs !== undefined) {
    headers["Retry-After"] = String(retryAfterSeconds(error.retryAfterMs));
  }
  return jsonResponse(ERROR_STATUS[error.code], errorEnvelope(error), headers);
}

function staticNotFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}
