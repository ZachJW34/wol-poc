import { describe, expect, test } from "bun:test";

import { normalizeMac, validateDeviceInput } from "../../src/shared/contracts";

describe("C1 validation", () => {
  test("trims the name and canonicalizes the MAC", () => {
    const result = validateDeviceInput({ name: " Office PC ", mac: "c8-53-09-f8-8a-32" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ name: "Office PC", mac: "C8:53:09:F8:8A:32" });
    }
  });

  test("accepts consistent colon separators and normalizes case", () => {
    expect(normalizeMac("c8:53:09:f8:8a:32")).toBe("C8:53:09:F8:8A:32");
    expect(normalizeMac("02:00:00:00:00:00")).toBe("02:00:00:00:00:00"); // locally administered unicast
  });

  test("accepts names of exactly 1 and 80 code units after trimming", () => {
    expect(validateDeviceInput({ name: "a", mac: "C8:53:09:F8:8A:32" }).ok).toBe(true);
    expect(
      validateDeviceInput({ name: "  " + "a".repeat(80) + "  ", mac: "C8:53:09:F8:8A:32" }).ok,
    ).toBe(true);
  });

  test("rejects blank and 81-character names", () => {
    expect(validateDeviceInput({ name: "   ", mac: "C8:53:09:F8:8A:32" }).ok).toBe(false);
    expect(validateDeviceInput({ name: "a".repeat(81), mac: "C8:53:09:F8:8A:32" }).ok).toBe(false);
  });

  test("rejects malformed MACs", () => {
    for (const mac of [
      "C8:53:09:F8:8A",
      "C8:53:09:F8:8A:32;id",
      "C85309F88A32",
      "C8:53-09:F8:8A:32",
      "C8 53 09 F8 8A 32",
      "GG:53:09:F8:8A:32",
      "",
    ]) {
      const result = validateDeviceInput({ name: "Device", mac });
      expect(result.ok, `expected ${mac} to be rejected`).toBe(false);
    }
  });

  test("rejects all-zero, all-FF, and multicast MACs", () => {
    for (const mac of ["00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF", "01:00:00:00:00:00"]) {
      expect(normalizeMac(mac)).toBeNull();
    }
  });

  test("does not coerce null, numbers, arrays, or missing fields", () => {
    const cases: unknown[] = [
      null,
      "Office PC",
      42,
      [1, 2, 3],
      { name: "Device" },
      { mac: "C8:53:09:F8:8A:32" },
      { name: null, mac: "C8:53:09:F8:8A:32" },
      { name: 7, mac: "C8:53:09:F8:8A:32" },
      { name: ["Device"], mac: "C8:53:09:F8:8A:32" },
      { name: "Device", mac: null },
      { name: "Device", mac: 42 },
    ];

    for (const value of cases) {
      const result = validateDeviceInput(value);
      expect(result.ok, `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
    }
  });

  test("rejects unexpected fields in create/edit bodies", () => {
    const result = validateDeviceInput({
      name: "Device",
      mac: "C8:53:09:F8:8A:32",
      id: "injected",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(false);
  });
});
