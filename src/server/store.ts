import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import { ERROR_CODES, validateDeviceInput } from "../shared/contracts";
import type { Device, DeviceInput } from "../shared/contracts";
import { HttpError } from "./errors";

/** C2 — one database file, one `devices` table, parameterized CRUD. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mac TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
)
`;

type DeviceRow = { id: string; name: string; mac: string; created_at: string };

function toDevice(row: DeviceRow): Device {
  return { id: row.id, name: row.name, mac: row.mac, createdAt: row.created_at };
}

export class DeviceStore {
  #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  /** Opens (and initializes) the persistent database. Failures throw; there is no in-memory fallback. */
  static open(path: string): DeviceStore {
    mkdirSync(dirname(path), { recursive: true });

    let db: Database;
    try {
      db = new Database(path);
    } catch (error) {
      throw new HttpError(
        ERROR_CODES.INTERNAL_ERROR,
        500,
        `Could not open the database at ${path}. Check that the path is writable by the service user.`,
      );
    }

    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);

    return new DeviceStore(db);
  }

  list(): Device[] {
    const rows = this.#db
      .query("SELECT id, name, mac, created_at FROM devices ORDER BY created_at ASC, id ASC")
      .all() as DeviceRow[];
    return rows.map(toDevice);
  }

  get(id: string): Device | null {
    const row = this.#db
      .query("SELECT id, name, mac, created_at FROM devices WHERE id = ?")
      .get(id) as DeviceRow | null;
    return row ? toDevice(row) : null;
  }

  create(input: DeviceInput): Device {
    const value = this.#canonical(input);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    try {
      this.#db
        .query("INSERT INTO devices (id, name, mac, created_at) VALUES (?, ?, ?, ?)")
        .run(id, value.name, value.mac, now);
    } catch (error) {
      throw this.#mapWriteError(error);
    }

    return { id, name: value.name, mac: value.mac, createdAt: now };
  }

  /** Complete replacement of name and mac; `createdAt` and `id` are immutable. */
  update(id: string, input: DeviceInput): Device | null {
    const existing = this.get(id);
    if (!existing) return null;

    const value = this.#canonical(input);

    try {
      this.#db
        .query("UPDATE devices SET name = ?, mac = ? WHERE id = ?")
        .run(value.name, value.mac, id);
    } catch (error) {
      throw this.#mapWriteError(error);
    }

    return { ...existing, name: value.name, mac: value.mac };
  }

  remove(id: string): boolean {
    const result = this.#db.query("DELETE FROM devices WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.#db.close();
  }

  #canonical(input: DeviceInput): DeviceInput {
    const result = validateDeviceInput(input);
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

  /** The unique constraint becomes a domain conflict, never a leaked SQL error. */
  #mapWriteError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed: devices.mac")) {
      return new HttpError(
        ERROR_CODES.DUPLICATE_MAC,
        409,
        "That MAC address is already registered.",
      );
    }
    throw error;
  }
}
