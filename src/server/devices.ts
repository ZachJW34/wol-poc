import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import {
  ApplicationError,
  type CreateDevice,
  type Device,
  type UpdateDevice,
} from "../shared/contracts.js";

/**
 * Schema version recorded in `PRAGMA user_version` for the devices table.
 * Future migrations bump this value; the repository refuses other versions.
 */
export const DEVICE_SCHEMA_VERSION = 1;

/**
 * Persistent device store (P03, C1). Synchronous `bun:sqlite` access with the
 * shared validation rules and shared error codes, so the HTTP layer can map
 * results without storage-specific knowledge.
 */
export interface DeviceRepository {
  /** Devices ordered by `name COLLATE BINARY ASC`, then `id`. */
  list(): Device[];
  /** Device by id, or `null` when it does not exist. */
  get(id: string): Device | null;
  /**
   * Insert a device. Input must be an object containing only C1 fields; unknown
   * keys (including `id` and `lastWakeSentAt`) throw `VALIDATION_ERROR`.
   * Duplicate normalized MACs throw `CONFLICT`.
   */
  create(input: CreateDevice): Device;
  /**
   * Patch a device. Input must be an object containing only C1 fields. Omitted
   * fields are preserved, `broadcastAddress: null` clears the stored override,
   * and an empty patch throws `VALIDATION_ERROR`.
   * Missing devices throw `NOT_FOUND`; a MAC already used by another device
   * throws `CONFLICT`.
   */
  update(id: string, input: UpdateDevice): Device;
  /** Delete a device. Missing devices throw `NOT_FOUND`. */
  delete(id: string): void;
  /** Record a successful wake. Missing devices throw `NOT_FOUND`. */
  recordWakeSent(id: string, sentAt: string): void;
  /** Close the underlying database handle. */
  close(): void;
}

type DeviceRow = {
  id: string;
  name: string;
  mac_address: string;
  broadcast_address: string | null;
  last_wake_sent_at: string | null;
};

const MAX_NAME_CODE_POINTS = 80;
const ALLOWED_FIELDS = new Set(["name", "macAddress", "broadcastAddress"]);
const CONTROL_CHARS = /\p{Cc}/u;
const HEX_OCTET = /^[0-9a-fA-F]{2}$/;
const DECIMAL_OCTET = /^\d{1,3}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mac_address TEXT NOT NULL UNIQUE,
  broadcast_address TEXT,
  last_wake_sent_at TEXT
)`;

const SELECT_SQL =
  "SELECT id, name, mac_address, broadcast_address, last_wake_sent_at " +
  "FROM devices";

/** User-safe message: never includes SQL, file paths, or driver details. */
const STORAGE_MESSAGE = "The device store could not be accessed.";

function validationError(field: string, message: string): ApplicationError {
  return new ApplicationError("VALIDATION_ERROR", `${field} ${message}`);
}

function notFoundError(): ApplicationError {
  return new ApplicationError("NOT_FOUND", "Device not found.");
}

function storageError(cause: unknown): ApplicationError {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
    return new ApplicationError(
      "CONFLICT",
      "A device with that MAC address already exists.",
    );
  }
  return new ApplicationError("INTERNAL_ERROR", STORAGE_MESSAGE);
}

/**
 * C1 input shape check: reject non-object JSON (null, arrays, primitives) and
 * unknown keys, including `id` and `lastWakeSentAt`, which clients cannot set.
 * Runs before any property access so runtime callers passing a non-object get
 * VALIDATION_ERROR instead of a raw TypeError.
 */
function validateInputShape(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("input", "must be an object");
  }
  const fields = input as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw validationError(key, "is not an allowed field");
    }
  }
  return fields;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") {
    throw validationError("name", "must be a string");
  }
  const name = value.trim();
  if (name.length === 0) {
    throw validationError("name", "must not be empty");
  }
  if (Array.from(name).length > MAX_NAME_CODE_POINTS) {
    throw validationError(
      "name",
      `must be at most ${MAX_NAME_CODE_POINTS} characters`,
    );
  }
  if (CONTROL_CHARS.test(name)) {
    throw validationError("name", "must not contain control characters");
  }
  return name;
}

function normalizeMacAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw validationError("macAddress", "must be a string");
  }
  const trimmed = value.trim();
  const separator = trimmed.includes("-") ? "-" : ":";
  const parts = trimmed.split(separator);
  if (parts.length !== 6 || parts.some((part) => !HEX_OCTET.test(part))) {
    throw validationError(
      "macAddress",
      'must be six hex octets separated by ":" or "-" consistently',
    );
  }
  const octets = parts.map((part) => part.toUpperCase());
  if (octets.every((octet) => octet === "00")) {
    throw validationError("macAddress", "must not be the all-zero address");
  }
  if (octets.every((octet) => octet === "FF")) {
    throw validationError(
      "macAddress",
      "must not be the all-FF broadcast address",
    );
  }
  if (Number.parseInt(octets[0], 16) % 2 === 1) {
    throw validationError("macAddress", "must not be a multicast address");
  }
  return octets.join(":");
}

function normalizeBroadcastAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw validationError("broadcastAddress", "must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw validationError("broadcastAddress", "must not be empty");
  }
  const parts = trimmed.split(".");
  if (parts.length !== 4 || parts.some((part) => !DECIMAL_OCTET.test(part))) {
    throw validationError(
      "broadcastAddress",
      "must be four decimal octets from 0 to 255",
    );
  }
  if (parts.some((part) => part.length > 1 && part.startsWith("0"))) {
    throw validationError(
      "broadcastAddress",
      "octets must not have leading zeros",
    );
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    throw validationError(
      "broadcastAddress",
      "must be four decimal octets from 0 to 255",
    );
  }
  if (octets.every((octet) => octet === 0)) {
    throw validationError("broadcastAddress", "must not be 0.0.0.0");
  }
  if (octets[0] >= 224 && octets[0] <= 239) {
    throw validationError(
      "broadcastAddress",
      "must not be in the multicast range 224.0.0.0/4",
    );
  }
  return octets.join(".");
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    throw validationError(
      "sentAt",
      "must be a UTC ISO 8601 timestamp such as 2026-01-02T03:04:05.000Z",
    );
  }
  return new Date(value).toISOString();
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    macAddress: row.mac_address,
    broadcastAddress: row.broadcast_address,
    lastWakeSentAt: row.last_wake_sent_at,
  };
}

class SqliteDeviceRepository implements DeviceRepository {
  readonly #db: Database;
  readonly #selectById: Statement<DeviceRow, [string]>;
  readonly #selectAll: Statement<DeviceRow, []>;
  readonly #insert: Statement<
    void,
    [string, string, string, string | null, string | null]
  >;
  readonly #recordWake: Statement<void, [string, string]>;
  readonly #deleteById: Statement<void, [string]>;
  #closed = false;

  constructor(db: Database) {
    this.#db = db;
    this.#selectById = db.prepare(`${SELECT_SQL} WHERE id = ?`);
    this.#selectAll = db.prepare(
      `${SELECT_SQL} ORDER BY name COLLATE BINARY ASC, id`,
    );
    this.#insert = db.prepare(
      "INSERT INTO devices (id, name, mac_address, broadcast_address, " +
        "last_wake_sent_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.#recordWake = db.prepare(
      "UPDATE devices SET last_wake_sent_at = ? WHERE id = ?",
    );
    this.#deleteById = db.prepare("DELETE FROM devices WHERE id = ?");
  }

  list(): Device[] {
    return this.#guard(() => this.#selectAll.all().map(toDevice));
  }

  get(id: string): Device | null {
    return this.#guard(() => {
      const row = this.#selectById.get(id);
      return row === null ? null : toDevice(row);
    });
  }

  create(input: CreateDevice): Device {
    const fields = validateInputShape(input);
    const name = normalizeName(fields.name);
    const macAddress = normalizeMacAddress(fields.macAddress);
    const broadcastAddress =
      fields.broadcastAddress === undefined || fields.broadcastAddress === null
        ? null
        : normalizeBroadcastAddress(fields.broadcastAddress);

    return this.#guard(() => {
      const id = crypto.randomUUID();
      this.#insert.run(id, name, macAddress, broadcastAddress, null);
      return {
        id,
        name,
        macAddress,
        broadcastAddress,
        lastWakeSentAt: null,
      };
    });
  }

  update(id: string, input: UpdateDevice): Device {
    const fields = validateInputShape(input);
    const assignments: string[] = [];
    const params: (string | null)[] = [];

    if (fields.name !== undefined) {
      assignments.push("name = ?");
      params.push(normalizeName(fields.name));
    }
    if (fields.macAddress !== undefined) {
      assignments.push("mac_address = ?");
      params.push(normalizeMacAddress(fields.macAddress));
    }
    if (fields.broadcastAddress !== undefined) {
      assignments.push("broadcast_address = ?");
      params.push(
        fields.broadcastAddress === null
          ? null
          : normalizeBroadcastAddress(fields.broadcastAddress),
      );
    }
    if (assignments.length === 0) {
      throw validationError("patch", "must provide at least one field");
    }

    return this.#guard(() => {
      const changes = this.#db
        .prepare(`UPDATE devices SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...params, id);
      if (changes.changes === 0) {
        throw notFoundError();
      }
      return this.get(id) as Device;
    });
  }

  delete(id: string): void {
    this.#guard(() => {
      const changes = this.#deleteById.run(id);
      if (changes.changes === 0) {
        throw notFoundError();
      }
    });
  }

  recordWakeSent(id: string, sentAt: string): void {
    const timestamp = normalizeTimestamp(sentAt);
    this.#guard(() => {
      const changes = this.#recordWake.run(timestamp, id);
      if (changes.changes === 0) {
        throw notFoundError();
      }
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#db.close();
  }

  #guard<T>(action: () => T): T {
    if (this.#closed) {
      throw new ApplicationError("INTERNAL_ERROR", STORAGE_MESSAGE);
    }
    try {
      return action();
    } catch (cause) {
      if (cause instanceof ApplicationError) {
        throw cause;
      }
      throw storageError(cause);
    }
  }
}

/**
 * Open (creating when needed) the device database at `databasePath` and return
 * a repository ready for use. The parent data directory is created safely, and
 * the schema init is repeatable.
 */
export function openDeviceRepository(databasePath: string): DeviceRepository {
  let db: Database;
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    db = new Database(databasePath);
  } catch {
    throw new ApplicationError("INTERNAL_ERROR", STORAGE_MESSAGE);
  }

  try {
    const row = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    } | null;
    const version = row?.user_version ?? 0;
    if (version !== 0 && version !== DEVICE_SCHEMA_VERSION) {
      throw new ApplicationError(
        "INTERNAL_ERROR",
        "The device store uses an unsupported schema version.",
      );
    }
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${DEVICE_SCHEMA_VERSION}`);
    return new SqliteDeviceRepository(db);
  } catch (cause) {
    db.close();
    if (cause instanceof ApplicationError) {
      throw cause;
    }
    throw storageError(cause);
  }
}
