# Implementation status — WOL-1

Branch `v2`, baseline commit `fb2bf09b4a1e004860f1379c38dbe6975208e6f5`. Single agent, no delegation.
All work is uncommitted at the time of writing.

**Overall: implemented and verified locally. Docker image build/run, hardware wake, phone, and
Tailscale acceptance are pending — they could not be observed on this host.** Nothing below marked
"pending" has been verified.

## Gates actually run

Run from the repository root with Bun 1.4.2.

| Command | Result | Evidence |
| --- | --- | --- |
| `bun install --frozen-lockfile` | pass | `Checked 82 installs across 149 packages (no changes)` — lockfile unchanged. |
| `bun run typecheck` | pass | Client, server, shared, and test configs, strict, no errors. |
| `bun run test` | pass | 60 pass / 0 fail, 222 expect() calls, 7 files. No real WoL packet: the adapter is exercised through an injected harmless executable. |
| `bun run build` | pass | `dist/index.html` 0.44 kB, `dist/assets/*.css` 12.50 kB, `dist/assets/*.js` 301.70 kB. |
| `bun run format:check` | pass | All matched files use Prettier style. One `prettier --write` pass was used, as the plan allows. |
| `bun run test:e2e` | pass | 26 tests (13 desktop + 13 phone-360) against the isolated fixture on `127.0.0.1:7323`. |
| `docker compose config --quiet` | pass | Exit 0 with `APP_ORIGIN` supplied. Client-side validation only; it does not prove the image builds or runs. |

Playwright prerequisite: Chromium 1248 is installed (`~/.cache/ms-playwright`), Playwright 1.64.1, no
missing system libraries. WebKit is not installed, so the mobile project is Chromium at a 360x720
viewport rather than an iPhone device descriptor.

## Live local smoke evidence

Run against the real production entrypoint from an isolated copy of `src/`, `dist/`, and
`package.json` in `/tmp/opencode/wol-smoke`, with a minimal environment so the operator's real `.env`
was neither read nor modified. Loopback only.

```text
GET  /api/health            200 application/json; charset=utf-8
GET  /                      200 text/html; charset=utf-8
GET  /assets/index-*.js     200 text/javascript; charset=utf-8
GET  /assets/index-*.css    200 text/css; charset=utf-8
POST /api/devices (Origin correct)  201, canonical MAC C8:53:09:F8:8A:32
POST /api/devices (Origin evil.example) 403 FORBIDDEN_ORIGIN, list unchanged afterwards
GET  /.env                  404
GET  /data/wol.sqlite       404
GET  /src/server/index.ts   404
GET  /../package.json       404
ss -ltn                     LISTEN ... 127.0.0.1:7123 only
SIGTERM                     "shutting down (SIGTERM)", process exits
restart                     the created device is still listed from the SQLite file
```

The wake route was exercised live only against the missing-binary path, which cannot emit a packet:

```text
POST /api/devices/<id>/wake   503 {"error":{"code":"WAKE_UNAVAILABLE",...}}
[wake] wake command is not available on this host
```

That is the real adapter, not a mock: `wakeonlan` is absent on this host, so no packet was sent and
none could be. Every other wake observation comes from unit and integration tests with an injected
harmless executable.

### Deployment configuration written for this machine

The operator asked for `.env` and `compose.yaml` to match their existing Tailscale Serve entry, so the
working agreement's "never touch the operator's `.env`" rule was set aside for this one write. The
previous `.env` was a copy of the old placeholder template (`HOST`, `PORT=3000`,
`APP_ORIGIN=https://app.example.invalid`, `WOL_BROADCAST_ADDRESS`, `/var/lib/wol-poc/...`); `HOST` and
`WOL_BROADCAST_ADDRESS` no longer exist in the config surface and were dropped.

```text
.env          PORT=7100
              APP_ORIGIN=https://zw-asus-laptop.tailb5e44.ts.net:7101
              DATABASE_PATH=/data/wol.sqlite      # the named volume; a host run needs ./data/...
              NODE_ENV=production
compose.yaml  PORT pinned to 7100 to match the Serve target, APP_ORIGIN read from .env,
              wol-data mounted at /data, network_mode: host, no ports: mapping
Serve         https://zw-asus-laptop.tailb5e44.ts.net:7101  ->  http://127.0.0.1:7100
```

`docker compose config` resolves these values with exit 0. The Origin check was re-run live against the
real entrypoint with a temp database (the volume path is not writable on this host):

```text
POST /api/devices  Origin: https://zw-asus-laptop.tailb5e44.ts.net:7101        201
POST /api/devices  Origin: https://zw-asus-laptop.tailb5e44.ts.net             403 FORBIDDEN_ORIGIN
GET  /api/health                                                              200
ss -ltn            LISTEN ... 127.0.0.1:7100 only
restart            the device created above is still listed from the SQLite file
```

The port is part of the origin, so `APP_ORIGIN` without `:7101` fails every mutation. This is handler
behaviour only: Serve itself, TLS, and the tailnet path were not exercised.

### Build-stage and runtime-stage checks (local simulations, not Docker evidence)

- An isolated directory mirroring `.dockerignore` (no `.env`, no `dist`, no `tests/e2e`) passes
  `bun run typecheck && bun run build && bun run test`. The build stage order was corrected to build
  before test, because the static-serving integration tests read the real `dist/` tree.
- `bun install --frozen-lockfile --production` works against the committed lockfile without modifying
  it (34 packages, 18 top-level), and `bun src/server/index.ts` serves health, `/`, and a mutation
  with production-only dependencies.
- `useradd` is used rather than `adduser`, because `adduser` is not present in the minimal Debian base.
- The health check now lives in `compose.yaml` rather than the `Dockerfile`, so it can read the service's
  own `PORT` instead of assuming an image default. Tradeoff: `docker run` without compose has no health
  check at all.
- The test is `CMD-SHELL` and resolves `process.env.PORT` inside the process. Nothing in the string uses
  `${}`, because compose interpolates `${...}` when the file is parsed: a `${PORT}` reference would be
  substituted from `.env` at parse time, not read at check time. The YAML scalar is quoted because an
  unquoted plain scalar cannot contain `": "`.
- Verified on the host, not inside a container, by running the exact string through `/bin/sh -c`:
  `PORT=7100` against a live server on `127.0.0.1:7100` exits 0; with `PORT` unset it falls back to `7123`
  and exits 1 when nothing is listening. `docker compose config` validates the file with exit 0.
- Assumption still unverified: `bun` must be on `PATH` inside the runtime image for `CMD-SHELL` to find it.
  Bun also loads `.env` from the working directory, so on the host the fallback is masked by the local
  `.env` (`PORT=7100`); inside the image `.env` is excluded by `.dockerignore`, so only the value compose
  passes is seen.
- `EXPOSE` cannot follow a runtime variable, so it remains documentation that must match the runtime
  `PORT`. Running the image without `PORT` uses the `7123` default, which does not match the `7100`
  Serve target on this machine; `compose.yaml` pins `7100`, so `docker compose` is unaffected.

## Pending — Docker

The Docker daemon is unreachable for this user:

```text
$ docker info
permission denied while trying to connect to the docker API at unix:///var/run/docker.sock   (exit 1)
$ docker build -t wol-poc .
ERROR: permission denied while trying to connect to the docker API at unix:///var/run/docker.sock   (exit 1)
```

The user is not in the `docker` group, `/var/run/docker.sock` is `root:docker` mode `srw-rw----`,
`sudo -n true` reports `sudo: a password is required`, there is no rootless socket, and `podman`,
`buildah`, and `hadolint` are not installed. So these remain unverified:

- `docker compose build`
- `docker compose run --rm --no-deps app sh -c 'id -u; command -v wakeonlan; test -w /data'`
- `docker compose up -d`, container healthcheck, and recreation-without-volume-loss
- that the runtime user can actually write the named volume

Documentary checks that were possible without a daemon (these are not build evidence):

- `oven/bun:1.4.2` is an active published tag (linux/amd64 and linux/arm64, last pushed 2026-09-05),
  and `latest` is the Debian variant, so `apt-get` is available in the runtime stage.
- Debian's `wakeonlan` package exists (bookworm/trixie/sid), installs `/usr/bin/wakeonlan`, and sends
  the packet as a UDP datagram, so it needs no root and no extra capabilities.
- `useradd` comes from the Essential `passwd` package, so it is present in the minimal Debian base;
  `adduser` is not, and the Dockerfile does not depend on it.

## Pending — hardware, network, and Tailscale

- `wakeonlan` is not installed on this host (`command -v wakeonlan` → not found), so no real command
  path has been observed end to end.
- No WoL-enabled target device, no LAN host, no tailnet, and no phone were available. The decisive
  test — phone on cellular with Tailscale, tap Wake, and watch a physical device actually wake — has
  not been performed and cannot be performed here.
- No live Tailscale configuration was inspected or changed, and no device was woken during
  implementation.
- Tailscale cannot send a magic packet itself; documented as an open feature request
  (tailscale/tailscale#306). The README's phone workflow relies on running the app on an always-on
  LAN machine and reaching it through an SSH tunnel, which is a documented pattern, not an observed
  result on this host.

## Notes and deliberate deviations

- `.prettierrc.json` previously configured only a Svelte plugin. It was replaced with a minimal
  React/TS-compatible configuration, as P01 authorises. `Dockerfile` and `IMPLEMENTATION.md` are in
  `.prettierignore`.
- `playwright.config.ts` uses `reuseExistingServer`; `reuseServer` is not a valid `webServer` key in
  Playwright 1.64.1 and failed typecheck.
- `src/server/index.ts` requires a UI build in production and warns when running the API alone in
  development/test, per C3.
- The E2E mobile project is Chromium at 360x720 because WebKit is not installed.
- The operator's real `.env` was not read or modified. Entrypoint tests spawn child processes with a
  minimal environment, and the live smoke run used an isolated working directory with no `.env`.
- No sample device was registered, and the MAC from the original example was never used in a wake.

## Next actions for the operator

1. Run the Docker gates on a Linux host with daemon access, including the non-root/writable-volume
   diagnostic.
2. Install `wakeonlan` on the deployment host and confirm it works outside Docker with an
   operator-approved MAC.
3. Perform the phone → Tailscale → LAN wake acceptance test and record whether the device physically
   woke, separately from the command's exit code.
