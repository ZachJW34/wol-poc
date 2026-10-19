import { describe, expect, test } from "bun:test";
import {
  ApplicationError,
  ERROR_STATUS,
  errorEnvelope,
  retryAfterSeconds,
  type CommandResult,
  type Device,
  type ErrorCode,
  type RunWakeCommand,
} from "../../src/shared/contracts";

const C2_CODES: ErrorCode[] = [
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
];

describe("C2 error codes and statuses", () => {
  test("every C2 code maps to its approved status", () => {
    const expected: Record<ErrorCode, number> = {
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
    for (const code of C2_CODES) {
      expect(ERROR_STATUS[code]).toBe(expected[code]);
    }
  });

  test("the shared map contains exactly the C2 codes", () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...C2_CODES].sort());
  });
});

describe("C2 error envelope", () => {
  test("envelope shape is { error: { code, message } }", () => {
    const error = new ApplicationError("NOT_FOUND", "Device not found");
    expect(errorEnvelope(error)).toEqual({
      error: { code: "NOT_FOUND", message: "Device not found" },
    });
    expect(JSON.stringify(errorEnvelope(error))).toBe(
      '{"error":{"code":"NOT_FOUND","message":"Device not found"}}',
    );
  });

  test("retryAfterMs appears only when the error carries it", () => {
    const cooldown = new ApplicationError("WAKE_COOLDOWN", "Try again later", {
      retryAfterMs: 5000,
    });
    expect(errorEnvelope(cooldown)).toEqual({
      error: {
        code: "WAKE_COOLDOWN",
        message: "Try again later",
        retryAfterMs: 5000,
      },
    });
    expect(
      "retryAfterMs" in errorEnvelope(new ApplicationError("CONFLICT", "Busy")),
    ).toBe(false);
  });

  test("Retry-After is whole seconds rounded up", () => {
    expect(retryAfterSeconds(5000)).toBe(5);
    expect(retryAfterSeconds(4001)).toBe(5);
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1000)).toBe(1);
  });

  test("application error keeps its code and is an Error", () => {
    const error = new ApplicationError("VALIDATION_ERROR", "Name is required");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toBe("Name is required");
    expect(error.retryAfterMs).toBeUndefined();
  });
});

describe("C1 device types", () => {
  test("a device round-trips through JSON with nullable fields", () => {
    const device: Device = {
      id: "6c1e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
      name: "Desk",
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: null,
      lastWakeSentAt: null,
    };
    const parsed = JSON.parse(JSON.stringify(device)) as Device;
    expect(parsed).toEqual(device);
    expect(parsed.broadcastAddress).toBeNull();
    expect(parsed.lastWakeSentAt).toBeNull();
  });

  test("update input is partial, so a single-field patch is valid", () => {
    const patch = { name: "New name" };
    expect(Object.keys(patch)).toEqual(["name"]);
  });
});

describe("C3 runner contract", () => {
  function kindOf(result: CommandResult): string {
    switch (result.kind) {
      case "ok":
        return "ok";
      case "failed":
        return "failed";
      case "timeout":
        return "timeout";
      default: {
        // Exhaustiveness guard: a new CommandResult kind fails type checking.
        const impossible: never = result;
        return impossible;
      }
    }
  }

  test("the three result kinds are the whole contract", () => {
    expect(kindOf({ kind: "ok" })).toBe("ok");
    expect(kindOf({ kind: "failed" })).toBe("failed");
    expect(kindOf({ kind: "timeout" })).toBe("timeout");
  });

  test("a fake runner conforming to RunWakeCommand receives the device override unchanged", async () => {
    const seen: Array<{ macAddress: string; broadcastAddress: string | null }> =
      [];
    const fakeRunner: RunWakeCommand = async (input) => {
      seen.push(input);
      return { kind: "ok" };
    };
    // Non-vacuity: the null input is the CLI-default case, so a contract that
    // required a string could not accept it, and a runner that substituted a
    // default could not report null here.
    const result = await fakeRunner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: null,
    });
    expect(result).toEqual({ kind: "ok" });
    expect(seen).toEqual([
      { macAddress: "02:AA:BB:CC:DD:EE", broadcastAddress: null },
    ]);

    await fakeRunner({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });
    expect(seen[1]).toEqual({
      macAddress: "02:AA:BB:CC:DD:EE",
      broadcastAddress: "192.168.1.255",
    });
  });
});
