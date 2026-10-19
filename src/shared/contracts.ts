/**
 * Shared contracts (C1 types, C2 error envelope, C3 runner types).
 *
 * These definitions are exported once from this module. Server modules, the
 * frontend API client, and tests import them from here; no other module may
 * redefine them. Validation rules and HTTP behaviour live in later packets.
 */

// C1 — device JSON shape.
export type Device = {
  id: string;
  name: string;
  macAddress: string;
  broadcastAddress: string | null;
  lastWakeSentAt: string | null;
};

export type CreateDevice = {
  name: string;
  macAddress: string;
  broadcastAddress?: string | null;
};

export type UpdateDevice = Partial<CreateDevice>;

// C2 — error codes and the JSON error envelope.
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "FORBIDDEN_ORIGIN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "WAKE_COOLDOWN"
  | "INTERNAL_ERROR"
  | "WAKE_FAILED"
  | "WAKE_TIMEOUT";

/** HTTP status for each C2 error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  WAKE_COOLDOWN: 429,
  INTERNAL_ERROR: 500,
  WAKE_FAILED: 502,
  WAKE_TIMEOUT: 504,
};

export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    message: string;
    retryAfterMs?: number;
  };
};

/**
 * Application error thrown by shared layers (repository, wake service) and
 * mapped to an HTTP status through ERROR_STATUS. Messages are sanitized: they
 * never contain raw process output, SQL, or database paths.
 */
export class ApplicationError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Build the C2 JSON error envelope for an application error. */
export function errorEnvelope(error: ApplicationError): ErrorEnvelope {
  const body: ErrorEnvelope = {
    error: { code: error.code, message: error.message },
  };
  if (error.retryAfterMs !== undefined) {
    body.error.retryAfterMs = error.retryAfterMs;
  }
  return body;
}

/** Whole-seconds `Retry-After` value, rounded up, for a cooldown delay. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.ceil(retryAfterMs / 1000);
}

// C3 — runner result and the injectable wake-command seam.
export type CommandResult =
  { kind: "ok" } | { kind: "failed" } | { kind: "timeout" };

export type RunWakeCommand = (input: {
  macAddress: string;
  broadcastAddress: string;
}) => Promise<CommandResult>;
