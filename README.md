# wol-poc

A small, private, mobile-friendly dashboard for saving LAN devices and requesting that the server
wake them. Devices are stored in SQLite, the API binds loopback only, and each wake runs the
installed `wakeonlan` command with the saved MAC.

**What it does:** sends a magic packet and reports "Wake request sent".
**What it does not do:** confirm the device actually woke. Exit code 0 means the command ran; the
NIC may be asleep, WoL may be disabled in firmware, or the packet may never reach the LAN. The UI
never claims a device is online, and there is no ping or online detection.

## Prerequisites

- Bun 1.4.2 or newer (`bun --version`).
- The `wakeonlan` command available on the server. On Debian/Ubuntu: `sudo apt install wakeonlan`.
  It sends the packet as an ordinary UDP datagram, so it does not need root. The host command is not
  inherited by the container; the image installs its own copy.
- Target devices must have Wake-on-LAN enabled (firmware/OS setting, for example
  `sudo ethtool -s eth0 wol g`) and must be on the same Layer 2 network as the machine running this
  app.

## Running it

```bash
bun install
cp .env.example .env      # then edit APP_ORIGIN
bun run dev               # Vite UI on http://localhost:5173, API proxied to 127.0.0.1:7123
```

Production is one Bun process that serves the built UI and the API:

```bash
bun run build             # client -> dist/
bun run start             # http://127.0.0.1:7123
```

Open `http://127.0.0.1:7123` in a browser on the same machine.

## Configuration

Only these variables are read. Old `HOST`, broadcast, and per-device override settings are ignored.

| Variable        | Default                                              | Meaning                                                          |
| --------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `PORT`          | `7123`                                               | Port bound on `127.0.0.1`. The bind address is not configurable. |
| `APP_ORIGIN`    | dev: `http://localhost:5173`; required in production | Origin that must match exactly for every mutation.               |
| `DATABASE_PATH` | `./data/wol.sqlite`                                  | SQLite file; in Docker, `/data/wol.sqlite`.                      |
| `NODE_ENV`      | `production`                                         | `development`, `production`, or `test`.                          |

**Origin settings.** In development the browser sends `http://localhost:5173`, which is the default.
Open the dev server at exactly `http://localhost:5173` — `http://127.0.0.1:5173` produces a different
origin and is rejected. For deployment, set `APP_ORIGIN` to the exact HTTPS origin reported by
`tailscale serve status`. Production rejects an HTTP origin; loopback HTTP is accepted only for an
explicit development/test configuration.

## API

JSON bodies on every response except `204`, and `Cache-Control: no-store` on all `/api` responses.

```text
GET    /api/health              200 {"ok":true}
GET    /api/devices             200 {"devices":[Device]}
POST   /api/devices             201 {"device":Device}   400 / 409
PATCH  /api/devices/:id         200 {"device":Device}   400 / 404 / 409
DELETE /api/devices/:id         204                     404
POST   /api/devices/:id/wake    200 {"status":"sent","deviceId":"..."}   404 / 409 / 502 / 503 / 504
```

A device is `{ id, name, mac, createdAt }`. Names are trimmed to 1–80 code units; MACs are
normalised to canonical uppercase colon form (`C8:53:09:F8:8A:32`) and are unique.

Errors use one envelope: `{"error":{"code":"...","message":"...","fields":{...}}}` with codes
`VALIDATION_ERROR`, `INVALID_JSON`, `FORBIDDEN_ORIGIN`, `UNSUPPORTED_MEDIA_TYPE`, `DUPLICATE_MAC`,
`NOT_FOUND`, `WAKE_IN_PROGRESS`, `WAKE_FAILED`, `WAKE_UNAVAILABLE`, `WAKE_TIMEOUT`,
`METHOD_NOT_ALLOWED`, `INTERNAL_ERROR`.

Every mutating request must send an `Origin` header equal to `APP_ORIGIN`, and JSON mutations need
`Content-Type: application/json`. These are CSRF defenses, not authentication.

```bash
# Create a device through the API, with the required Origin header.
curl -s -X POST http://127.0.0.1:7123/api/devices \
  -H 'Origin: http://127.0.0.1:7123' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Office PC","mac":"c8-53-09-f8-8a-32"}'

# Wake it. The body must be an empty JSON object.
curl -s -X POST http://127.0.0.1:7123/api/devices/<id>/wake \
  -H 'Origin: http://127.0.0.1:7123' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## Docker

```bash
APP_ORIGIN=https://<hostname-placeholder>.ts.net docker compose up -d --build
```

- Multi-stage build: locked dependencies and the Vite build in the build stage, then a Debian-based
  `oven/bun:1.4.2` runtime with Debian's `wakeonlan` package, running as a non-root user.
- `network_mode: host` is required. A bridge-networked container sends the magic packet from the
  Docker bridge, where the broadcast does not reach the LAN. Do not switch to bridge networking or
  bind `0.0.0.0` to "fix" connectivity.
- There is no `ports:` mapping because the app binds `127.0.0.1` only. Reach it from the host, or
  tunnel it: `ssh -L 7123:127.0.0.1:7123 user@host`.
- The database lives in the named volume `wol-data` mounted at `/data`, owned by the runtime user.
- Avoid `docker compose down -v`: it destroys the persistent volume.

Inspect the runtime image before trusting it:

```bash
docker compose run --rm --no-deps app sh -c 'id -u; command -v wakeonlan; test -w /data && echo writable'
```

Restart and upgrade: `docker compose restart` for a restart; `docker compose up -d --build` after
changing code. The volume survives recreation.

## Tailscale

Tailscale runs on the host, not inside this image. Check what is already configured before changing
anything:

```bash
tailscale serve status
```

If Serve is not already serving something else, point it at the loopback backend (this will not
replace an existing Serve configuration):

```bash
tailscale serve --bg http://127.0.0.1:7123
```

Then set `APP_ORIGIN` to the exact HTTPS origin displayed by Serve. MagicDNS, certificates, and
tailnet access grants are host prerequisites. Do not enable Funnel, and do not reset an existing Serve
configuration.

### This machine

Serve on `zw-asus-laptop` exposes `https://zw-asus-laptop.tailb5e44.ts.net:7101` and proxies it to
`http://127.0.0.1:7100`, so `.env` sets `PORT=7100` and
`APP_ORIGIN=https://zw-asus-laptop.tailb5e44.ts.net:7101`. The port is part of the origin: opening the
dashboard through `:7101` makes the browser send exactly that Origin, while `APP_ORIGIN` without `:7101`
produces a different Origin and every mutation returns 403. `compose.yaml` reads `APP_ORIGIN` from
`.env` and pins `PORT` to `7100` to match the Serve target; changing one without the other breaks the
proxy or the Origin check.

Tailscale cannot send a magic packet for you: WoL is a Layer 2 frame, Tailscale works at Layer 3, and
native WoL support is still an open feature request
([tailscale/tailscale#306](https://github.com/tailscale/tailscale/issues/306)). The working pattern is
to run this app on an always-on machine physically on the same LAN as the target, then reach it over
Tailscale. Because the app is loopback-only, use an SSH tunnel rather than exposing the port:

```bash
tailscale set --ssh                       # on the machine running the app, once
ssh -L 7123:127.0.0.1:7123 user@that-machine   # from a laptop or phone on the tailnet
```

Open `http://127.0.0.1:7123` locally; the browser sends that same origin, so the Origin check keeps
working through the tunnel. There is no app login: tailnet policy decides who may use the whole
dashboard, and everyone allowed can edit, delete, and wake every device.

## Backup and restore

Stop the service first, then copy the whole database directory including the `-wal` and `-shm`
sidecars. Never copy only a live WAL-mode database file.

```bash
docker compose stop
docker run --rm -v wol-data:/data -v "$PWD/backup:/backup" oven/bun:1.4.2 \
  sh -c 'cp -a /data/. /backup/'
```

Restore by copying the files back into the volume while the service is stopped. For direct Bun
execution, stop the process and copy `data/`.

## Troubleshooting

- **`wakeonlan` not found** — the wake route returns `503 WAKE_UNAVAILABLE`. Install the package on
  the host, or confirm it exists inside the image with the diagnostic above. The host binary is not
  inherited by the container.
- **Wrong origin** — `403 FORBIDDEN_ORIGIN` on mutations. The browser origin must equal `APP_ORIGIN`
  exactly, including scheme and port. Opening the dev server on `127.0.0.1:5173` instead of
  `localhost:5173` is the usual development cause.
- **Database not writable** — startup fails with an actionable message instead of falling back to an
  in-memory store. Check ownership of the volume or `DATABASE_PATH`; do not fix it with privileged
  mode or a broad `chmod`.
- **Command succeeds but the device does not wake** — this is expected behaviour, not a bug. Check
  firmware/OS WoL settings, the NIC (a wireless NIC usually cannot wake), the cable, and whether the
  packet's route reaches the LAN. Compare the host CLI with the container CLI on the same MAC.
- **Multi-NIC or VPN routing** — the magic packet follows the host's route for the destination
  broadcast. A container on a bridge network, a VPN interface, or a second NIC can send it somewhere
  the target never hears. Host networking on the LAN host is the supported path; Docker Desktop and
  rootless Docker are outside the verified target.
- **Port already in use** — `7123` may be taken by another service. Report the conflict rather than
  silently changing the endpoint; change `PORT` and the Serve configuration together if you intend to
  move it.

## Development commands

```bash
bun run typecheck     # client, server, shared, and test TypeScript configurations
bun run test          # unit + integration gates; cannot wake real equipment
bun run build         # production client build into dist/
bun run format:check  # Prettier
bun run test:e2e      # Playwright journeys against an isolated fixture server on 7323
```

Playwright Chromium is an explicit prerequisite: `bunx --bun playwright install chromium`.

See `AGENTS.md` for the working agreement and `IMPLEMENTATION.md` for the approved contract.
`IMPLEMENTATION_STATUS.md` records what has actually been verified and what is still pending.
