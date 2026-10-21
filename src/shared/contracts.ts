/**
 * C1 — shared device contract and pure input validation.
 *
 * No runtime, framework, or I/O here: the client and the server both consume these
 * types, and the validation rules are the single source of truth for both.
 */

export type Device = {
  /** Server-created `crypto.randomUUID()`; immutable. */
  id: string;
  /** Trimmed, 1-80 JavaScript string code units. */
  name: string;
  /** Canonical uppercase colon-separated MAC. */
  mac: string;
  /** Server-generated UTC ISO-8601 timestamp; immutable. */
  createdAt: string;
};

export type DeviceInput = { name: string; mac: string };

export type FieldName = "name" | "mac";

export type ApiError = {
  error: {
    code: string;
    message: string;
    fields?: Partial<Record<FieldName, string>>;
  };
};

export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_JSON: "INVALID_JSON",
  FORBIDDEN_ORIGIN: "FORBIDDEN_ORIGIN",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  DUPLICATE_MAC: "DUPLICATE_MAC",
  NOT_FOUND: "NOT_FOUND",
  WAKE_IN_PROGRESS: "WAKE_IN_PROGRESS",
  WAKE_FAILED: "WAKE_FAILED",
  WAKE_UNAVAILABLE: "WAKE_UNAVAILABLE",
  WAKE_TIMEOUT: "WAKE_TIMEOUT",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const NAME_MAX = 80;

/** Six hex byte pairs with one consistent separator; returns canonical uppercase colons. */
export function normalizeMac(raw: string): string | null {
  const separator = raw.includes("-") ? "-" : raw.includes(":") ? ":" : null;
  if (separator === null) return null;

  const parts = raw.split(separator);
  if (parts.length !== 6) return null; // also rejects mixed separators
  if (!parts.every((part) => /^[0-9a-fA-F]{2}$/.test(part))) return null;

  const bytes = parts.map((part) => Number.parseInt(part, 16));
  const first = bytes[0]!;

  if (bytes.every((byte) => byte === 0)) return null; // all-zero
  if (bytes.every((byte) => byte === 255)) return null; // all-FF broadcast
  if ((first & 1) === 1) return null; // multicast (low bit of first byte)

  return parts.map((part) => part.toUpperCase()).join(":");
}

export type ValidationResult =
  { ok: true; input: DeviceInput } | { ok: false; fields: Partial<Record<FieldName, string>> };

/**
 * Accepts only a JSON object with string `name` and `mac`. Nothing is coerced:
 * null, numbers, arrays, missing fields, and unexpected fields are rejected.
 */
export function validateDeviceInput(value: unknown): ValidationResult {
  const fields: Partial<Record<FieldName, string>> = {};

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, fields: { name: "Expected a JSON object." } };
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const unexpected = keys.filter((key) => key !== "name" && key !== "mac");
  if (unexpected.length > 0) {
    return { ok: false, fields: { name: `Unexpected field: ${unexpected.join(", ")}.` } };
  }

  if (typeof record.name !== "string") {
    fields.name = "Name must be a string.";
  } else {
    const name = record.name.trim();
    if (name.length === 0) fields.name = "Name is required.";
    else if (name.length > NAME_MAX) fields.name = `Name must be at most ${NAME_MAX} characters.`;
  }

  if (typeof record.mac !== "string") {
    fields.mac = "MAC must be a string.";
  } else if (normalizeMac(record.mac) === null) {
    fields.mac = "MAC must be six hex byte pairs with consistent : or - separators.";
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };

  return {
    ok: true,
    input: {
      name: (record.name as string).trim(),
      mac: normalizeMac(record.mac as string)!,
    },
  };
}
