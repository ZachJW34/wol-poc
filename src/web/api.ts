import {
  ApplicationError,
  type CreateDevice,
  type Device,
  type ErrorEnvelope,
  type ErrorCode,
  type UpdateDevice,
} from "../shared/contracts";

/**
 * P07 API client: same-origin relative `/api` fetches (C4). The browser sets
 * `Origin` itself; nothing here sets it manually or uses an absolute base URL.
 *
 * Every failure is surfaced as the shared C2 `ApplicationError`, so the UI can
 * react to the code (`WAKE_COOLDOWN` delay, `CONFLICT` preservation) without
 * re-implementing server rules.
 */
const DEVICES_PATH = "/api/devices";

/** Successful `POST /api/devices/:id/wake` body (C2/C3). */
export type WakeResponse = { device: Device; message: string };

/** Fetch the device list. Rejects with a sanitized message on failure. */
export async function fetchDevices(): Promise<Device[]> {
  const response = await fetch(DEVICES_PATH);
  if (!response.ok) {
    throw await errorFrom(response, "Device list failed.");
  }

  const body = (await response.json()) as { devices?: unknown };
  if (!Array.isArray(body.devices) || !body.devices.every(isDevice)) {
    throw new Error("Device list response was malformed.");
  }
  return body.devices as Device[];
}

/** Register a device. Server validation and duplicate rules stay authoritative. */
export async function createDevice(input: CreateDevice): Promise<Device> {
  const response = await fetch(DEVICES_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readDevice(response, "Device operation failed.");
}

/**
 * Patch a device. The payload carries only C1 fields: `id` and
 * `lastWakeSentAt` are never sent, and an omitted field preserves the stored
 * value while `broadcastAddress: null` clears the override.
 */
export async function updateDevice(
  id: string,
  patch: UpdateDevice,
): Promise<Device> {
  const response = await fetch(`${DEVICES_PATH}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return readDevice(response, "Device operation failed.");
}

/** Delete a device. A 204 has no body, so success is the status alone. */
export async function deleteDevice(id: string): Promise<void> {
  const response = await fetch(`${DEVICES_PATH}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (response.ok) {
    return;
  }
  throw await errorFrom(response, "Device operation failed.");
}

/** Ask the server to send one wake packet for a registered device. */
export async function wakeDevice(id: string): Promise<WakeResponse> {
  const response = await fetch(
    `${DEVICES_PATH}/${encodeURIComponent(id)}/wake`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw await errorFrom(response, "Wake failed.");
  }

  const body = (await response.json()) as {
    device?: unknown;
    message?: unknown;
  };
  if (!isDevice(body.device)) {
    throw new Error("Wake response was malformed.");
  }
  return {
    device: body.device,
    message:
      typeof body.message === "string" ? body.message : "Wake packet sent",
  };
}

async function readDevice(
  response: Response,
  fallbackMessage: string,
): Promise<Device> {
  if (!response.ok) {
    throw await errorFrom(response, fallbackMessage);
  }
  const body = (await response.json()) as { device?: unknown };
  if (!isDevice(body.device)) {
    throw new Error("Device response was malformed.");
  }
  return body.device;
}

/** Parse the shared C2 envelope; a non-JSON failure keeps a status message. */
async function errorFrom(
  response: Response,
  fallbackMessage: string,
): Promise<ApplicationError> {
  try {
    const body = (await response.json()) as Partial<ErrorEnvelope>;
    const error = body?.error;
    if (error && typeof error.code === "string" && isErrorCode(error.code)) {
      return new ApplicationError(
        error.code,
        messageOr(error.message, fallbackMessage),
        {
          retryAfterMs:
            typeof error.retryAfterMs === "number"
              ? error.retryAfterMs
              : undefined,
        },
      );
    }
  } catch {
    // A non-JSON failure falls back to the status-based message.
  }
  return new ApplicationError(
    "INTERNAL_ERROR",
    `${fallbackMessage} (${response.status})`,
  );
}

function messageOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const ERROR_CODES = new Set<string>([
  "VALIDATION_ERROR",
  "FORBIDDEN_ORIGIN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "WAKE_COOLDOWN",
  "INTERNAL_ERROR",
  "WAKE_FAILED",
  "WAKE_TIMEOUT",
]);

function isErrorCode(code: string): code is ErrorCode {
  return ERROR_CODES.has(code);
}

function isDevice(value: unknown): value is Device {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Device).id === "string" &&
    typeof (value as Device).name === "string" &&
    typeof (value as Device).macAddress === "string"
  );
}
