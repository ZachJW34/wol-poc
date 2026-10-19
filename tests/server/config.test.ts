import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { ConfigError, loadConfig } from "../../src/server/config";

const CWD = process.cwd();
const STATIC_ROOT = resolve(CWD, "dist");

// A complete, valid environment for each mode; individual tests change one key.
function env(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_ORIGIN: "https://wol.tailnet.example",
    WOL_BROADCAST_ADDRESS: "192.168.1.255",
    ...overrides,
  };
}

function load(
  overrides: Record<string, string | undefined>,
  mode: "production" | "development" | "test",
) {
  return loadConfig(env(overrides), { mode });
}

describe("defaults", () => {
  test("a valid production environment uses the approved defaults", () => {
    const config = load({}, "production");
    expect(config.mode).toBe("production");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.appOrigin).toBe("https://wol.tailnet.example");
    expect(config.broadcastAddress).toBe("192.168.1.255");
    expect(config.databasePath).toBe(join(CWD, "data", "wol.sqlite"));
    expect(config.staticRoot).toBe(STATIC_ROOT);
  });
});

describe("HOST", () => {
  test("loopback literals are accepted", () => {
    expect(load({ HOST: "127.0.0.1" }, "production").host).toBe("127.0.0.1");
    expect(load({ HOST: "::1" }, "test").host).toBe("::1");
  });

  test("a non-loopback bind is rejected in every mode", () => {
    for (const mode of ["production", "development", "test"] as const) {
      expect(() => load({ HOST: "0.0.0.0" }, mode)).toThrow(ConfigError);
      expect(() => load({ HOST: "192.168.1.20" }, mode)).toThrow(/loopback/);
    }
  });

  test("a hostname is not an IP literal", () => {
    expect(() => load({ HOST: "wol.tailnet.example" }, "production")).toThrow(
      /IP literal/,
    );
  });
});

describe("PORT", () => {
  test("integer ports inside the range are accepted", () => {
    expect(load({ PORT: "8080" }, "test").port).toBe(8080);
  });

  test("non-integers and out-of-range ports are rejected", () => {
    for (const raw of ["3000.5", "abc", "0", "65536", "-1"]) {
      expect(() => load({ PORT: raw }, "test")).toThrow(ConfigError);
    }
  });
});

describe("APP_ORIGIN", () => {
  test("an HTTPS origin is required in production", () => {
    expect(
      load({ APP_ORIGIN: "https://wol.tailnet.example" }, "production")
        .appOrigin,
    ).toBe("https://wol.tailnet.example");
    expect(() =>
      load({ APP_ORIGIN: "http://127.0.0.1:3000" }, "production"),
    ).toThrow(/HTTPS origin/);
    expect(() => load({ APP_ORIGIN: "" }, "production")).toThrow(/required/);
  });

  test("loopback HTTP is accepted only for an explicit development/test mode", () => {
    expect(
      load({ APP_ORIGIN: "http://127.0.0.1:3000" }, "development").appOrigin,
    ).toBe("http://127.0.0.1:3000");
    expect(
      load({ APP_ORIGIN: "http://localhost:3000" }, "test").appOrigin,
    ).toBe("http://localhost:3000");
    expect(() =>
      load({ APP_ORIGIN: "http://192.168.1.20:3000" }, "test"),
    ).toThrow(/loopback origin/);
  });

  test("path, query, fragment, and credentials are rejected", () => {
    for (const origin of [
      "https://wol.tailnet.example/app",
      "https://wol.tailnet.example?x=1",
      "https://wol.tailnet.example#top",
      "https://user:pass@wol.tailnet.example",
      "not a url",
      "ftp://wol.tailnet.example",
    ]) {
      expect(() => load({ APP_ORIGIN: origin }, "production")).toThrow(
        ConfigError,
      );
    }
  });
});

describe("WOL_BROADCAST_ADDRESS", () => {
  test("an operator-supplied IPv4 broadcast address is accepted", () => {
    expect(
      load({ WOL_BROADCAST_ADDRESS: "192.168.1.255" }, "production")
        .broadcastAddress,
    ).toBe("192.168.1.255");
    expect(
      load({ WOL_BROADCAST_ADDRESS: "10.0.0.31" }, "test").broadcastAddress,
    ).toBe("10.0.0.31");
  });

  test("missing, malformed, wildcard, and multicast addresses are rejected", () => {
    for (const raw of [
      "",
      "192.168.1",
      "192.168.1.256",
      "192.168.01.255",
      "0.0.0.0",
      "224.0.0.1",
      "239.255.255.255",
      "ff02::1",
    ]) {
      expect(() => load({ WOL_BROADCAST_ADDRESS: raw }, "production")).toThrow(
        ConfigError,
      );
    }
  });
});

describe("DATABASE_PATH", () => {
  test("a data directory outside the served static root is accepted", () => {
    expect(
      load({ DATABASE_PATH: "./data/wol.sqlite" }, "production").databasePath,
    ).toBe(join(CWD, "data", "wol.sqlite"));
    expect(
      load({ DATABASE_PATH: "/var/lib/wol/wol.sqlite" }, "production")
        .databasePath,
    ).toBe("/var/lib/wol/wol.sqlite");
  });

  test("a database inside the served static assets is rejected", () => {
    for (const raw of ["dist/wol.sqlite", "./dist/nested/wol.sqlite", "dist"]) {
      expect(() => load({ DATABASE_PATH: raw }, "production")).toThrow(
        /inside the served static/,
      );
    }
  });
});
