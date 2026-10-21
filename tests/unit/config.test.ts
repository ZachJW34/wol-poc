import { describe, expect, test } from "bun:test";

import { ConfigError, loadConfig } from "../../src/server/config";

describe("C5 configuration", () => {
  test("documented defaults", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.port).toBe(7123);
    expect(config.bind).toBe("127.0.0.1");
    expect(config.appOrigin).toBe("http://localhost:5173");
    expect(config.databasePath).toBe("./data/wol.sqlite");
  });

  test("bind address is fixed to loopback regardless of input", () => {
    const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://phone.ts.net" });
    expect(config.bind).toBe("127.0.0.1");
  });

  test("production requires APP_ORIGIN and rejects an HTTP origin", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);

    const https = loadConfig({
      NODE_ENV: "production",
      APP_ORIGIN: "https://tailscale-name.ts.net",
    });
    expect(https.appOrigin).toBe("https://tailscale-name.ts.net");

    expect(() =>
      loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://name.ts.net/app" }),
    ).toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://u:p@name.ts.net" }),
    ).toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://name.ts.net?x=1" }),
    ).toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://name.ts.net#top" }),
    ).toThrow();
    expect(() => loadConfig({ NODE_ENV: "production", APP_ORIGIN: "ftp://name.ts.net" })).toThrow();
  });

  test("HTTP is accepted only for a literal loopback origin", () => {
    expect(
      loadConfig({ NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:7123" }).appOrigin,
    ).toBe("http://127.0.0.1:7123");
    expect(() =>
      loadConfig({ NODE_ENV: "production", APP_ORIGIN: "http://lan-host:7123" }),
    ).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", APP_ORIGIN: "https://name.ts.net" })).toThrow();
  });

  test("the stored origin is the canonical URL origin", () => {
    expect(
      loadConfig({ NODE_ENV: "development", APP_ORIGIN: "http://localhost:5173/" }).appOrigin,
    ).toBe("http://localhost:5173");
  });

  test("PORT must be an integer in range", () => {
    const origin = "http://127.0.0.1:7123";
    expect(loadConfig({ NODE_ENV: "test", APP_ORIGIN: origin, PORT: "7124" }).port).toBe(7124);
    for (const port of ["0", "65536", "abc", "71.5", "-1"]) {
      expect(
        () => loadConfig({ NODE_ENV: "test", APP_ORIGIN: origin, PORT: port }),
        `port ${port}`,
      ).toThrow(ConfigError);
    }
  });

  test("NODE_ENV is restricted and never enables fake-wake behavior", () => {
    for (const env of ["development", "production", "test"] as const) {
      expect(loadConfig({ NODE_ENV: env, APP_ORIGIN: "http://127.0.0.1:7123" }).env).toBe(env);
    }
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(ConfigError);
  });

  test("legacy HOST and broadcast settings are ignored", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      HOST: "0.0.0.0",
      WOL_BROADCAST_ADDRESS: "192.168.1.255",
    });
    expect(config.bind).toBe("127.0.0.1");
    expect(config).not.toHaveProperty("broadcast");
  });
});
