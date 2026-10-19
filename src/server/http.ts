/**
 * P04 request-side helpers for the C2 HTTP boundary: the checks that must run
 * before a mutation reaches the repository.
 *
 * - Origin equality with the configured `APP_ORIGIN` (no CORS, no forwarded
 *   headers, no permissive fallback).
 * - `application/json` content type for create/patch, with an optional charset.
 * - A bounded read of the *actual* body bytes. `Content-Length` is never trusted
 *   as the limit because it can be absent or misleading.
 */
import { ApplicationError } from "../shared/contracts";

/** C2 maximum request body size, in actual bytes. */
export const MAX_BODY_BYTES = 8192;

/**
 * Require an `Origin` exactly equal to the configured application origin. An
 * absent, `null`, or foreign origin is rejected before any mutation.
 */
export function requireOrigin(request: Request, appOrigin: string): void {
  const origin = request.headers.get("origin");
  if (origin !== appOrigin) {
    throw new ApplicationError(
      "FORBIDDEN_ORIGIN",
      "Origin does not match the configured application origin.",
    );
  }
}

/**
 * Require `application/json`. The only allowed parameter is an optional
 * `charset`, and it must be `utf-8`; any other parameter is rejected.
 */
export function requireJsonContentType(request: Request): void {
  const header = request.headers.get("content-type");
  if (header === null) {
    throw new ApplicationError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }

  const [mediaType, ...parameters] = header.split(";");
  if (mediaType.trim().toLowerCase() !== "application/json") {
    throw new ApplicationError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }

  for (const parameter of parameters) {
    const [name, ...rest] = parameter.split("=");
    const value = rest
      .join("=")
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (
      name.trim().toLowerCase() !== "charset" ||
      value.toLowerCase() !== "utf-8"
    ) {
      throw new ApplicationError(
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json with an optional charset parameter.",
      );
    }
  }
}

/**
 * Read the actual body bytes and reject anything over `MAX_BODY_BYTES` while
 * streaming, so a missing or misleading `Content-Length` cannot bypass the limit.
 */
export async function readBodyBytes(request: Request): Promise<Uint8Array> {
  const stream = request.body;
  if (stream === null) {
    return new Uint8Array();
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    const chunk =
      value instanceof Uint8Array
        ? value
        : new TextEncoder().encode(String(value));
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApplicationError(
        "PAYLOAD_TOO_LARGE",
        `Request body must be at most ${MAX_BODY_BYTES} bytes.`,
      );
    }
    chunks.push(chunk);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** Read a JSON body after the content-type check. */
export async function readJsonBody(request: Request): Promise<unknown> {
  requireJsonContentType(request);
  const bytes = await readBodyBytes(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      "Request body must be valid JSON.",
    );
  }
  return parsed;
}
