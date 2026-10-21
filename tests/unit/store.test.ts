import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { ERROR_CODES } from "../../src/shared/contracts";
import { HttpError } from "../../src/server/errors";
import { DeviceStore } from "../../src/server/store";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wol-store-")), "wol.sqlite");
}

describe("C2 store", () => {
  test("create, list, get, update, and remove against a real database file", () => {
    const path = tempPath();
    const store = DeviceStore.open(path);

    const created = store.create({ name: "Office PC", mac: "C8:53:09:F8:8A:32" });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    expect(store.get(created.id)).toEqual(created);
    expect(store.list()).toEqual([created]);

    const updated = store.update(created.id, { name: "  Desk  ", mac: "c8-53-09-f8-8a-32" });
    expect(updated).toEqual({ ...created, name: "Desk", mac: "C8:53:09:F8:8A:32" });

    expect(store.remove(created.id)).toBe(true);
    expect(store.remove(created.id)).toBe(false);
    expect(store.list()).toEqual([]);

    store.close();
  });

  test("creates the database parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "wol-store-"));
    const store = DeviceStore.open(join(dir, "nested", "deep", "wol.sqlite"));
    store.create({ name: "Device", mac: "C8:53:09:F8:8A:32" });
    expect(store.list().length).toBe(1);
    store.close();
  });

  test("duplicate MAC becomes a domain conflict, not a SQL error", () => {
    const store = DeviceStore.open(tempPath());
    store.create({ name: "First", mac: "C8:53:09:F8:8A:32" });

    let error: unknown;
    try {
      store.create({ name: "Second", mac: "c8:53:09:f8:8a:32" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe(ERROR_CODES.DUPLICATE_MAC);
    expect((error as HttpError).message).not.toContain("UNIQUE constraint");
    expect((error as HttpError).message).not.toContain("sqlite");
    store.close();
  });

  test("editing a device to its own MAC does not conflict with itself", () => {
    const store = DeviceStore.open(tempPath());
    const device = store.create({ name: "Office PC", mac: "C8:53:09:F8:8A:32" });
    store.create({ name: "Other", mac: "AA:BB:CC:DD:EE:01" });

    const renamed = store.update(device.id, { name: "Renamed", mac: "C8:53:09:F8:8A:32" });
    expect(renamed?.name).toBe("Renamed");
    store.close();
  });

  test("a failed write leaves existing data unchanged", () => {
    const store = DeviceStore.open(tempPath());
    const device = store.create({ name: "Office PC", mac: "C8:53:09:F8:8A:32" });
    store.create({ name: "Other", mac: "AA:BB:CC:DD:EE:01" });

    // Conflict with the second device: the first device keeps its original values.
    expect(() => store.update(device.id, { name: "Bad", mac: "AA:BB:CC:DD:EE:01" })).toThrow(
      HttpError,
    );
    expect(store.get(device.id)).toEqual(device);

    expect(() => store.update(device.id, { name: "", mac: "C8:53:09:F8:8A:32" })).toThrow(
      HttpError,
    );
    expect(store.get(device.id)).toEqual(device);
    store.close();
  });

  test("list is ordered by createdAt then id", () => {
    const store = DeviceStore.open(tempPath());
    const first = store.create({ name: "First", mac: "AA:AA:AA:AA:AA:01" });
    const second = store.create({ name: "Second", mac: "AA:AA:AA:AA:AA:02" });

    const listed = store.list();
    expect(listed.length).toBe(2);
    const key = (d: { createdAt: string; id: string }) => `${d.createdAt}\u0000${d.id}`;
    expect([key(listed[0]!), key(listed[1]!)]).toEqual([key(first), key(second)].sort());
    store.close();
  });

  test("reopening the same file retains data", () => {
    const path = tempPath();
    const first = DeviceStore.open(path);
    const device = first.create({ name: "Persistent", mac: "C8:53:09:F8:8A:32" });
    first.close();

    const reopened = DeviceStore.open(path);
    expect(reopened.list()).toEqual([device]);
    expect(reopened.get(device.id)).toEqual(device);
    reopened.close();
  });

  test("an SQL-like name is stored as text, not executed", () => {
    const store = DeviceStore.open(tempPath());
    const name = "Robert'); DROP TABLE devices;--";
    const device = store.create({ name, mac: "C8:53:09:F8:8A:32" });
    expect(store.get(device.id)?.name).toBe(name);
    expect(store.list().length).toBe(1);
    store.close();
  });

  test("store validates before writing", () => {
    const store = DeviceStore.open(tempPath());
    expect(() => store.create({ name: "ok", mac: "nope" })).toThrow(HttpError);
    store.close();
  });
});
