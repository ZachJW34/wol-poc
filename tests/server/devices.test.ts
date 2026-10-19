import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  ApplicationError,
  ERROR_STATUS,
  type CreateDevice,
  type Device,
  type ErrorCode,
  type UpdateDevice,
} from "../../src/shared/contracts.js";
import {
  DEVICE_SCHEMA_VERSION,
  openDeviceRepository,
  type DeviceRepository,
} from "../../src/server/devices.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function openTempRepository(): Promise<{
  repo: DeviceRepository;
  path: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "wol-poc-devices-"));
  const path = join(dir, "devices.sqlite3");
  const repo = openDeviceRepository(path);
  return {
    repo,
    path,
    async cleanup() {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (cause) {
    return cause;
  }
  return null;
}

function expectAppError(
  action: () => unknown,
  code: ErrorCode,
  context?: string,
): ApplicationError {
  const cause = capture(action);
  expect(cause, context).toBeInstanceOf(ApplicationError);
  const error = cause as ApplicationError;
  expect(error.code, context).toBe(code);
  expect(ERROR_STATUS[error.code], context).toBe(ERROR_STATUS[code]);
  return error;
}

function isCleanStorageError(error: ApplicationError, path: string): void {
  expect(error.code).toBe("INTERNAL_ERROR");
  expect(error.message).not.toContain(path);
  expect(error.message).not.toMatch(/sqlite|SQL|SELECT|table|devices/i);
}

describe("device repository persistence", () => {
  it("creates a device and reads it back normalized", async () => {
    const fixture = await openTempRepository();
    try {
      const device = fixture.repo.create({
        name: "  Lab Bench  ",
        macAddress: "aa-b1-c2-d3-e4-f5",
        broadcastAddress: "192.168.1.255",
      });
      expect(device.id).toMatch(UUID_PATTERN);
      expect(device.name).toBe("Lab Bench");
      expect(device.macAddress).toBe("AA:B1:C2:D3:E4:F5");
      expect(device.broadcastAddress).toBe("192.168.1.255");
      expect(device.lastWakeSentAt).toBeNull();
      expect(fixture.repo.get(device.id)).toEqual(device);
      expect(fixture.repo.list()).toEqual([device]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("leaves the broadcast override null when omitted or explicitly null", async () => {
    const fixture = await openTempRepository();
    try {
      const omitted = fixture.repo.create({
        name: "Omitted",
        macAddress: "12:22:33:44:55:66",
      });
      const explicit = fixture.repo.create({
        name: "Explicit",
        macAddress: "12:22:33:44:55:67",
        broadcastAddress: null,
      });
      expect(omitted.broadcastAddress).toBeNull();
      expect(explicit.broadcastAddress).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects unknown keys, including fields clients cannot set", async () => {
    const fixture = await openTempRepository();
    try {
      const base = { name: "Caller Fields", macAddress: "20:21:22:23:24:25" };
      for (const input of [
        { ...base, id: "caller-chosen-id" },
        { ...base, lastWakeSentAt: "2020-01-01T00:00:00.000Z" },
        { ...base, extra: "not a C1 field" },
      ]) {
        const error = expectAppError(
          () => fixture.repo.create(input as CreateDevice),
          "VALIDATION_ERROR",
          JSON.stringify(input),
        );
        expect(error.message).toContain(Object.keys(input)[2]);
      }
      // A clean create still works, so rejected input never reaches the store.
      const device = fixture.repo.create(base);
      expect(device.id).toMatch(UUID_PATTERN);
      expect(device.lastWakeSentAt).toBeNull();

      for (const patch of [
        { name: "Renamed", id: "caller-chosen-id" },
        { name: "Renamed", lastWakeSentAt: "2020-01-01T00:00:00.000Z" },
        { name: "Renamed", extra: "not a C1 field" },
      ]) {
        const error = expectAppError(
          () => fixture.repo.update(device.id, patch as UpdateDevice),
          "VALIDATION_ERROR",
          JSON.stringify(patch),
        );
        expect(error.message).toContain(Object.keys(patch)[1]);
      }
      expect(fixture.repo.get(device.id)).toEqual(device);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects non-object input before reading any property", async () => {
    const fixture = await openTempRepository();
    try {
      for (const input of [null, undefined, 42, "string", true, [1, 2, 3]]) {
        expect(
          expectAppError(
            () => fixture.repo.create(input as unknown as CreateDevice),
            "VALIDATION_ERROR",
            String(input),
          ),
        );
        expect(
          expectAppError(
            () =>
              fixture.repo.update("any-id", input as unknown as UpdateDevice),
            "VALIDATION_ERROR",
            String(input),
          ),
        );
      }
      expect(fixture.repo.list()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns null for an unknown id", async () => {
    const fixture = await openTempRepository();
    try {
      expect(fixture.repo.get("does-not-exist")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("orders devices by binary name collation, then id", async () => {
    const fixture = await openTempRepository();
    try {
      const first = fixture.repo.create({
        name: "Alpha",
        macAddress: "40:41:42:43:44:46",
      });
      // Deterministic tie group: two same-name rows with known ids whose
      // lexical order is the reverse of insertion order, inserted through an
      // isolated raw connection to the fixture DB. If the repository omitted
      // the `id` tie-breaker, SQLite would return insertion order and this
      // assertion would fail. Production UUID generation is unchanged.
      const earlierLexicalId = "00000000-0000-4000-8000-000000000001";
      const laterLexicalId = "00000000-0000-4000-8000-000000000002";
      const raw = new Database(fixture.path);
      try {
        const insert = raw.prepare(
          "INSERT INTO devices (id, name, mac_address, broadcast_address, " +
            "last_wake_sent_at) VALUES (?, ?, ?, ?, ?)",
        );
        insert.run(laterLexicalId, "beta", "40:41:42:43:44:45", null, null);
        insert.run(earlierLexicalId, "beta", "40:41:42:43:44:47", null, null);
      } finally {
        raw.close();
      }
      // Binary collation puts uppercase before lowercase, so "Alpha" first,
      // then the two "beta" devices ordered by id (opposite insertion order).
      expect(fixture.repo.list().map((device) => device.id)).toEqual([
        first.id,
        earlierLexicalId,
        laterLexicalId,
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("allows duplicate names but rejects duplicate normalized MACs", async () => {
    const fixture = await openTempRepository();
    try {
      fixture.repo.create({
        name: "Twin",
        macAddress: "50:51:52:53:54:55",
      });
      const twin = fixture.repo.create({
        name: "Twin",
        macAddress: "50:51:52:53:54:56",
      });
      expect(fixture.repo.list().length).toBe(2);
      expect(
        expectAppError(
          () =>
            fixture.repo.create({
              name: "Twin Again",
              macAddress: "50-51-52-53-54-55",
            }),
          "CONFLICT",
        ),
      );
      expect(fixture.repo.get(twin.id)?.name).toBe("Twin");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects duplicate MACs on edit, including normalized forms", async () => {
    const fixture = await openTempRepository();
    try {
      const first = fixture.repo.create({
        name: "First",
        macAddress: "60:61:62:63:64:65",
      });
      const second = fixture.repo.create({
        name: "Second",
        macAddress: "60-61-62-63-64-66",
      });
      expect(
        expectAppError(
          () =>
            fixture.repo.update(first.id, {
              macAddress: " 60:61:62:63:64:66 ",
            }),
          "CONFLICT",
        ),
      );
      // Re-saving a device's own MAC is not a conflict.
      expect(
        fixture.repo.update(second.id, { macAddress: "60:61:62:63:64:66" }).id,
      ).toBe(second.id);
      expect(fixture.repo.get(first.id)?.macAddress).toBe("60:61:62:63:64:65");
    } finally {
      await fixture.cleanup();
    }
  });

  it("writes the wake timestamp", async () => {
    const fixture = await openTempRepository();
    try {
      const device = fixture.repo.create({
        name: "Wake",
        macAddress: "30:31:32:33:34:35",
      });
      fixture.repo.recordWakeSent(device.id, "2026-02-03T04:05:06.007Z");
      expect(fixture.repo.get(device.id)?.lastWakeSentAt).toBe(
        "2026-02-03T04:05:06.007Z",
      );
      expect(
        expectAppError(
          () =>
            fixture.repo.recordWakeSent("missing", "2026-02-03T04:05:06.007Z"),
          "NOT_FOUND",
        ),
      );
      expect(
        expectAppError(
          () => fixture.repo.recordWakeSent(device.id, "2026-02-03"),
          "VALIDATION_ERROR",
        ),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("deletes devices and reports missing devices as NOT_FOUND", async () => {
    const fixture = await openTempRepository();
    try {
      const device = fixture.repo.create({
        name: "Remove Me",
        macAddress: "90:91:92:93:94:95",
      });
      expect(
        expectAppError(
          () => fixture.repo.update("nope", { name: "x" }),
          "NOT_FOUND",
        ),
      );
      expect(expectAppError(() => fixture.repo.delete("nope"), "NOT_FOUND"));
      fixture.repo.delete(device.id);
      expect(fixture.repo.list()).toEqual([]);
      expect(fixture.repo.get(device.id)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps devices after close and reopen of a real database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wol-poc-devices-"));
    const path = join(dir, "devices.sqlite3");
    const first = openDeviceRepository(path);
    let device: Device;
    try {
      device = first.create({
        name: "Persisted",
        macAddress: "70:71:72:73:74:75",
      });
      // Write the wake timestamp before closing so the reopen proves a
      // non-null lastWakeSentAt survives, not just the registration row.
      first.recordWakeSent(device.id, "2026-02-03T04:05:06.007Z");
    } finally {
      first.close();
    }
    const persisted = { ...device, lastWakeSentAt: "2026-02-03T04:05:06.007Z" };
    // Reopening the same path proves the init is repeatable and data persists.
    const second = openDeviceRepository(path);
    try {
      expect(second.get(device.id)).toEqual(persisted);
      expect(second.get(device.id)?.lastWakeSentAt).toBe(
        "2026-02-03T04:05:06.007Z",
      );
      expect(second.list()).toEqual([persisted]);
    } finally {
      second.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates the parent data directory when it does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wol-poc-devices-"));
    const path = join(dir, "nested", "deeper", "devices.sqlite3");
    const repo = openDeviceRepository(path);
    try {
      const device = repo.create({
        name: "Nested",
        macAddress: "80:81:82:83:84:85",
      });
      expect(repo.list()).toEqual([device]);
    } finally {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records the schema version and refuses other versions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wol-poc-devices-"));
    const path = join(dir, "devices.sqlite3");
    const repo = openDeviceRepository(path);
    try {
      const raw = new Database(path);
      try {
        const row = raw.prepare("PRAGMA user_version").get() as {
          user_version: number;
        } | null;
        expect(row?.user_version).toBe(DEVICE_SCHEMA_VERSION);
      } finally {
        raw.close();
      }
    } finally {
      repo.close();
    }

    const raw = new Database(path);
    try {
      raw.exec("PRAGMA user_version = 99");
    } finally {
      raw.close();
    }
    const error = capture(() => openDeviceRepository(path));
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe("INTERNAL_ERROR");
    expect((error as ApplicationError).message).not.toContain(path);
    await rm(dir, { recursive: true, force: true });
  });

  it("stores SQL-like input as data, not as executable SQL", async () => {
    const fixture = await openTempRepository();
    try {
      const injection = "Robert'); DROP TABLE devices;--";
      const device = fixture.repo.create({
        name: injection,
        macAddress: "A0:A1:A2:A3:A4:A5",
        broadcastAddress: "10.0.0.255",
      });
      expect(fixture.repo.get(device.id)?.name).toBe(injection);
      expect(fixture.repo.list().length).toBe(1);
      // The table is still there, so the input was data rather than a statement.
      expect(fixture.repo.update(device.id, { name: "Renamed" }).name).toBe(
        "Renamed",
      );
      expect(
        expectAppError(
          () =>
            fixture.repo.create({
              name: "Injection As Data",
              macAddress: "' OR 1=1--",
            }),
          "VALIDATION_ERROR",
        ),
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("device validation", () => {
  it("trims names and rejects empty, oversized, and control characters", async () => {
    const fixture = await openTempRepository();
    try {
      expect(
        fixture.repo.create({
          name: "  Unicode ✓  ",
          macAddress: "B0:B1:B2:B3:B4:B5",
        }).name,
      ).toBe("Unicode ✓");
      expect(
        Array.from(
          fixture.repo.create({
            name: "x".repeat(80),
            macAddress: "B0:B1:B2:B3:B4:B6",
          }).name,
        ).length,
      ).toBe(80);
      // C1 counts Unicode code points, so supplementary characters (emoji, two
      // UTF-16 code units each) must be measured as one character each.
      const emoji80 = "😀".repeat(80);
      expect(
        Array.from(
          fixture.repo.create({
            name: emoji80,
            macAddress: "B0:B1:B2:B3:B4:B8",
          }).name,
        ).length,
      ).toBe(80);
      expect(
        Array.from(
          fixture.repo.create({
            name: "  " + emoji80 + "  ",
            macAddress: "B0:B1:B2:B3:B4:B9",
          }).name,
        ).length,
      ).toBe(80);
      const emoji81 = "😀".repeat(81);
      expect(Array.from(emoji81).length).toBe(81);
      for (const name of [
        "",
        "   ",
        "x".repeat(81),
        emoji81,
        "dev\n1",
        "dev\u0007",
        "\u0000",
        42 as unknown as string,
      ]) {
        expect(
          expectAppError(
            () =>
              fixture.repo.create({ name, macAddress: "B0:B1:B2:B3:B4:B7" }),
            "VALIDATION_ERROR",
          ),
          JSON.stringify(name),
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("normalizes MACs to uppercase colon form", async () => {
    const fixture = await openTempRepository();
    try {
      const cases: Array<[string, string]> = [
        ["aa-b1-c2-d3-e4-f5", "AA:B1:C2:D3:E4:F5"],
        ["AA:B1:C2:D3:E4:F6", "AA:B1:C2:D3:E4:F6"],
        [" aA:b1:c2:d3:e4:f7 ", "AA:B1:C2:D3:E4:F7"],
        ["00-01-02-03-04-08", "00:01:02:03:04:08"],
        ["02:03:04:05:06:09", "02:03:04:05:06:09"],
      ];
      for (const [index, [macAddress, expected]] of cases.entries()) {
        const device = fixture.repo.create({
          name: `Mac ${index}`,
          macAddress,
        });
        expect(device.macAddress).toBe(expected);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects malformed and reserved MACs", async () => {
    const fixture = await openTempRepository();
    try {
      for (const macAddress of [
        "",
        "AA:BB:CC:DD:EE",
        "AA:BB:CC:DD:EE:FF:00",
        "AA-BB:CC-DD-EE-F0",
        "GG:HH:II:JJ:KK:LL",
        "00:00:00:00:00:00",
        "FF:FF:FF:FF:FF:FF",
        "01:00:00:00:00:00",
        "03:11:22:33:44:55",
        null as unknown as string,
      ]) {
        expect(
          expectAppError(
            () => fixture.repo.create({ name: "Bad Mac", macAddress }),
            "VALIDATION_ERROR",
          ),
          String(macAddress),
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("normalizes broadcasts and allows directed broadcasts", async () => {
    const fixture = await openTempRepository();
    try {
      const device = fixture.repo.create({
        name: "Broadcast",
        macAddress: "C0:C1:C2:C3:C4:C5",
        broadcastAddress: " 192.168.1.255 ",
      });
      expect(device.broadcastAddress).toBe("192.168.1.255");
      expect(
        fixture.repo.create({
          name: "Single Zero",
          macAddress: "C0:C1:C2:C3:C4:C6",
          broadcastAddress: "0.0.0.1",
        }).broadcastAddress,
      ).toBe("0.0.0.1");
      expect(
        fixture.repo.create({
          name: "Limited",
          macAddress: "C0:C1:C2:C3:C4:C7",
          broadcastAddress: "255.255.255.255",
        }).broadcastAddress,
      ).toBe("255.255.255.255");
      // C1 prohibits only 0.0.0.0 and 224.0.0.0/4, so 240.0.0.1 is a
      // syntactically valid address and must be accepted.
      expect(
        fixture.repo.create({
          name: "Outside Multicast",
          macAddress: "C0:C1:C2:C3:C4:C8",
          broadcastAddress: "240.0.0.1",
        }).broadcastAddress,
      ).toBe("240.0.0.1");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects malformed and reserved broadcasts", async () => {
    const fixture = await openTempRepository();
    try {
      for (const broadcastAddress of [
        "",
        "   ",
        "192.168.1",
        "192.168.1.256",
        "192.168.1.01",
        "192.168.1.a",
        "0.0.0.0",
        "224.0.0.0",
        "239.255.255.255",
      ]) {
        expect(
          expectAppError(
            () =>
              fixture.repo.create({
                name: "Bad Broadcast",
                macAddress: "D0:D1:D2:D3:D4:D5",
                broadcastAddress,
              }),
            "VALIDATION_ERROR",
          ),
          broadcastAddress,
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("accepts octets up to 255 and rejects numeric octets above 255", async () => {
    const fixture = await openTempRepository();
    try {
      const accepted = ["255.255.255.255", "192.168.1.255", "0.0.0.255"];
      for (const [index, broadcastAddress] of accepted.entries()) {
        expect(
          fixture.repo.create({
            name: `Bound ${broadcastAddress}`,
            macAddress: `D2:D1:D1:D1:D1:D${6 + index}`,
            broadcastAddress,
          }).broadcastAddress,
        ).toBe(broadcastAddress);
      }
      const rejected = ["192.168.1.256", "192.168.1.999", "256.0.0.1"];
      for (const [index, broadcastAddress] of rejected.entries()) {
        const error = expectAppError(
          () =>
            fixture.repo.create({
              name: "Over Bound",
              macAddress: `D2:D2:D2:D2:D2:D${6 + index}`,
              broadcastAddress,
            }),
          "VALIDATION_ERROR",
          broadcastAddress,
        );
        expect(error.message).toContain("0 to 255");
      }
      // The same bounds apply on patch, and a rejected patch leaves the device.
      const device = fixture.repo.create({
        name: "Bound Patch",
        macAddress: "D2:D3:D3:D3:D3:D3",
        broadcastAddress: "192.168.1.255",
      });
      expect(
        expectAppError(
          () =>
            fixture.repo.update(device.id, {
              broadcastAddress: "192.168.1.999",
            }),
          "VALIDATION_ERROR",
        ),
      );
      expect(fixture.repo.get(device.id)?.broadcastAddress).toBe(
        "192.168.1.255",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("device patch semantics", () => {
  it("preserves omitted fields and clears broadcast only when explicitly null", async () => {
    const fixture = await openTempRepository();
    try {
      const device = fixture.repo.create({
        name: "Patch",
        macAddress: "E0:E1:E2:E3:E4:E5",
        broadcastAddress: "10.0.0.255",
      });

      const renamed = fixture.repo.update(device.id, { name: "Renamed" });
      expect(renamed).toEqual({ ...device, name: "Renamed" });

      const remac = fixture.repo.update(device.id, {
        macAddress: "e0:e1:e2:e3:e4:e6",
      });
      expect(remac.macAddress).toBe("E0:E1:E2:E3:E4:E6");
      expect(remac.name).toBe("Renamed");
      expect(remac.broadcastAddress).toBe("10.0.0.255");

      const cleared = fixture.repo.update(device.id, {
        broadcastAddress: null,
      });
      expect(cleared.broadcastAddress).toBeNull();
      expect(cleared.name).toBe("Renamed");
      expect(cleared.macAddress).toBe("E0:E1:E2:E3:E4:E6");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects empty patches and empty field values", async () => {
    const fixture = await openTempRepository();
    try {
      const device = fixture.repo.create({
        name: "Empty Patch",
        macAddress: "F0:F1:F2:F3:F4:F5",
        broadcastAddress: "10.0.0.255",
      });

      expect(
        expectAppError(
          () => fixture.repo.update(device.id, {}),
          "VALIDATION_ERROR",
        ),
      );
      for (const patch of [
        { name: "" },
        { name: "   " },
        { macAddress: "" },
        { broadcastAddress: "" },
        { broadcastAddress: "   " },
      ]) {
        expect(
          expectAppError(
            () => fixture.repo.update(device.id, patch),
            "VALIDATION_ERROR",
          ),
          JSON.stringify(patch),
        );
      }
      expect(fixture.repo.get(device.id)).toEqual(device);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("storage error sanitization", () => {
  it("reports a closed repository without leaking internals", async () => {
    const fixture = await openTempRepository();
    fixture.repo.create({
      name: "Closed",
      macAddress: "A2:A3:A4:A5:A6:A7",
    });
    fixture.repo.close();
    const error = expectAppError(() => fixture.repo.list(), "INTERNAL_ERROR");
    expect(error.message).not.toContain(fixture.path);
    expect(error.message).not.toMatch(/sqlite|SQL|table|devices/i);
    // Closing twice is harmless.
    fixture.repo.close();
    await fixture.cleanup();
  });

  it("sanitizes failures while preparing the data directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wol-poc-devices-"));
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const path = join(blocker, "devices.sqlite3");
    const error = capture(() => openDeviceRepository(path));
    expect(error).toBeInstanceOf(ApplicationError);
    isCleanStorageError(error as ApplicationError, path);
    await rm(dir, { recursive: true, force: true });
  });

  it("sanitizes failures from an unusable database file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wol-poc-devices-"));
    const path = join(dir, "devices.sqlite3");
    await writeFile(path, "this is not a sqlite database");
    const error = capture(() => openDeviceRepository(path));
    expect(error).toBeInstanceOf(ApplicationError);
    isCleanStorageError(error as ApplicationError, path);
    await rm(dir, { recursive: true, force: true });
  });

  it("never exposes SQL in unexpected storage failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wol-poc-devices-"));
    const path = join(dir, "devices.sqlite3");
    const repo = openDeviceRepository(path);
    try {
      const device = repo.create({
        name: "Leak",
        macAddress: "A2:A3:A4:A5:A6:A8",
      });
      const raw = new Database(path);
      try {
        raw.exec("DROP TABLE devices");
      } finally {
        raw.close();
      }
      const error = expectAppError(() => repo.list(), "INTERNAL_ERROR");
      isCleanStorageError(error, path);
      expect(error.message).not.toContain(device.id);
    } finally {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps test databases isolated from the runtime data directory", async () => {
    const fixture = await openTempRepository();
    try {
      expect(fixture.path.startsWith(join(tmpdir(), "wol-poc-devices-"))).toBe(
        true,
      );
      expect(fixture.path).not.toContain(join(process.cwd(), "data"));
      expect(fixture.repo.list()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
