# WoL web app

A small Wake-on-LAN web app: one Bun process serves the built Svelte frontend
and a same-origin API, persists device registrations in SQLite, and runs the
installed `wakeonlan` CLI as `wakeonlan <mac address>`, which uses that CLI's
own default broadcast. Only a device with a saved per-device override is sent
with an address: `wakeonlan -i <broadcast address> <mac address>`. No shell
expansion, no subnet inference, and no global broadcast setting.
Product contracts live in `docs/plan.md` and `docs/IMPLEMENTATION.md`.

The app records that a wake command completed. It does not know, and never
claims, whether a target machine booted.

## Toolchain

Verified runtime at bootstrap (unchanged since):

- Bun `1.4.2` (`/home/zachjw34/.bun/bin/bun`), Linux x86_64. `bun:sqlite`,
  `Bun.serve`, and `Bun.spawn` were confirmed available. No runtime upgrade was
  performed; the selected package versions are compatible with this Bun version.
- Node `26.11.1` is present on PATH and is used by the tool binaries that carry
  a `node` shebang (`vite`, `svelte-check`, `playwright`, `prettier`).

Pinned development tooling (see `package.json`):

| Package                        | Version | Role                                              |
| ------------------------------ | ------- | ------------------------------------------------- |
| `svelte`                       | 5.57.2  | frontend (Svelte 5)                               |
| `vite`                         | 8.3.4   | frontend build                                    |
| `@sveltejs/vite-plugin-svelte` | 7.3.1   | Vite Svelte plugin                                |
| `svelte-check`                 | 4.7.7   | Svelte + TypeScript checking                      |
| `typescript`                   | 5.9.3   | type checking (`svelte-check` peer requires `^5`) |
| `@playwright/test`             | 1.64.1  | Chromium browser tests                            |
| `prettier`                     | 3.9.10  | formatting gate                                   |
| `prettier-plugin-svelte`       | 4.1.1   | Svelte formatting                                 |
| `@types/bun`                   | 1.4.3   | Bun runtime types                                 |

Playwright Chromium is installed as a project test dependency only:
`bunx playwright install chromium`. No global or system packages are installed.

### Scripts

| Command                | What it does                                                |
| ---------------------- | ----------------------------------------------------------- |
| `bun run check`        | `svelte-check` over frontend, server, shared, and test code |
| `bun run test:server`  | `bun test tests/server`                                     |
| `bun run build`        | `vite build` into `dist`                                    |
| `bun run test:e2e`     | `playwright test` against the harness at a 390px viewport   |
| `bun run format:check` | Prettier check with the Svelte plugin                       |
| `bun run start`        | `bun src/server/index.ts`: the production composition       |

## Running the app

1. `bun install`, then `bun run build`. The build is a prerequisite for
   `bun run start`: startup checks for `dist/index.html` before anything else.
2. Copy `.env.example` to a real environment file and replace every placeholder
   with the operator's approved values. Bun loads `.env` from the process
   working directory, so `bun run start` reads it; a service should use an
   `EnvironmentFile` outside the served root instead.
3. Install the `wakeonlan` CLI and make sure the runtime `PATH` can find it.
4. `bun run start`.

Startup order is fixed: configuration is validated, the build output is checked,
the CLI is resolved from PATH, and only then is the store opened and the
listener created. Invalid configuration, a missing build, or a missing
executable therefore fails startup with an actionable message before any data
directory is created or any port is opened. The availability check inspects PATH
only; it never executes the CLI.

### Environment

| Variable        | Rule                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `HOST`          | optional; default `127.0.0.1`; production accepts only `127.0.0.1` or `::1`                             |
| `PORT`          | optional; default `3000`; integer 1–65535                                                               |
| `APP_ORIGIN`    | required; one origin-only HTTPS URL (loopback HTTP only for an explicit development/test configuration) |
| `DATABASE_PATH` | optional; default `./data/wol.sqlite` resolved from the working directory; must be outside `dist`       |

There is no broadcast variable. `WOL_BROADCAST_ADDRESS` is not read at all, so a
value left in an old environment file is inert and cannot reach a command, and
stored per-device overrides are unaffected by its removal.

`.env.example` is the minimal shape an operator fills in; the hostname is the
only value that cannot be used as written. Nothing in it has been checked
against a real machine or network.

Minimal example: the loopback backend on port 7123 behind the existing private
HTTPS proxy that serves the browser origin on port 7124.

```dotenv
HOST=127.0.0.1
PORT=7123
APP_ORIGIN=https://<hostname-placeholder>:7124
DATABASE_PATH=./data/wol.sqlite
```

The app does not terminate TLS and opens no public listener; the proxy forwards
to the loopback backend, and `APP_ORIGIN` must be exactly the origin the browser
uses. A service should use a persistent `DATABASE_PATH` owned by the service
user instead of a working-directory path.

## Access model

The app binds loopback only. The approved access path is the existing private
HTTPS proxy forwarding to this loopback backend: the app does not terminate TLS
and opens no public listener. `APP_ORIGIN` is the single origin the browser
uses, and every mutation requires an `Origin` exactly equal to it; an absent,
`null`, or foreign origin is rejected with 403 before any store access. There is
no CORS configuration and no trust in forwarded headers.

Static responses read only the build root: percent-decoded traversal, dotfiles,
encoded separators, and any target outside `dist` are denied, so the SQLite file
can never be served. That is why `DATABASE_PATH` must live outside `dist`.

## Broadcast and reachability

With no saved override the app passes only the MAC address, so the destination is
whatever the installed `wakeonlan` CLI defaults to on the host that runs it; the
app does not choose, infer, or hardcode that address. A saved per-device override
still wins for that device and is passed as `-i`.

Removing the old global setting does not change stored device overrides. A wrong
override is corrected in the Edit form: clear the Broadcast override field and
save, which stores null and restores the CLI default for that device.

Valid syntax cannot prove an override is the operator's working subnet broadcast,
and a successful wake means only that the CLI exited 0; it does not show that a
machine booted. Neither the API nor the UI reports a device as online, reachable,
or booted.

## Data and backup

Devices are stored in SQLite at `DATABASE_PATH`. To back up, stop the service
and copy the database file, or use `sqlite3 <path> ".backup <copy>"`, and
include any `-wal`/`-shm` files that exist. Use a persistent location owned by
the service user, for example `/var/lib/wol-poc/wol-poc.sqlite`, outside the
build output. The store creates its parent directory when it is opened; a path
that startup rejects is never created.

## Service operation

`docs/wol-poc.service` is an example unit file only. Nothing in this project
installs, enables, or starts a service, and no system or Tailscale
configuration is changed. The example shows the shape an operator needs: an
unprivileged `User`, an explicit `WorkingDirectory` (the static root resolves as
`<WorkingDirectory>/dist`), an `EnvironmentFile` outside the served root, a
persistent absolute `DATABASE_PATH`, and a `PATH` containing the installed
`wakeonlan` CLI.

## Diagnostics and troubleshooting

- Production startup logs one line to stderr (`Serving on http://host:port`)
  and exits 1 with an actionable message for invalid configuration, a missing
  build, or a missing executable.
- Each wake attempt logs bounded diagnostics to stderr: the argv, exit code,
  timeout flag, captured byte count (combined stdout and stderr, capped at
  8 KiB), and a bounded spawn-failure reason. Command output is never rendered
  into an HTTP response, and no secrets or full request bodies are logged.
- A wake command has a fixed 5-second timeout. A fixed 5-second per-device
  cooldown starts when a command completes, on success and failure alike; an
  in-flight duplicate or a cooldown hit returns 429 with `Retry-After`, which
  the UI honors before re-enabling the control.
- Request bodies are limited to 8192 actual bytes measured while streaming, and
  `Content-Type` must be `application/json`; `Content-Length` is not trusted as
  the limit.

| Symptom                             | What to check                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| startup: CLI not available          | the CLI is installed and the service `PATH` includes its directory                                                     |
| startup: static build not found     | `bun run build` ran in the same working directory the service uses                                                     |
| 403 `FORBIDDEN_ORIGIN`              | the browser origin equals `APP_ORIGIN`; the proxy forwards the real origin                                             |
| 404 on a page path                  | there are no client-side routes; only files inside `dist` are served                                                   |
| wake succeeds, target does not boot | the CLI default or the device's saved override, and the target's WoL capability, are operator questions, not app state |

## Tests

`tests/server` runs under Bun and `tests/e2e` under Playwright Chromium at a
390px viewport. The e2e harness (`tests/e2e/harness.ts`) starts the production
composition root with harness-only injected fakes, so browser tests exercise the
same startup path production uses while nothing resolves or executes the
installed CLI. The harness serves the build on a loopback test port (default
`3123`, override with `E2E_PORT`) and reads no production environment flags.

## Pending

The earlier bootstrap check found no installed `wakeonlan` on this machine
(`command -v wakeonlan` → not found). That records the state of that check, not
the current host: the operator reports running `wakeonlan <MAC>` manually and
waking the target, which is evidence for that manual command only. No app or
phone live smoke test has been run independently, and the CLI's `-i` argument
support has not been confirmed from the host. The exact argv contract is
implemented and tested through an injected spawn seam; confirming `-i` against
the real CLI matters only when an optional per-device override is used, and
remains pending for the separately authorized P09 deployment smoke test, along
with live phone/proxy verification.

Formatting excludes `docs/plan.md`, `docs/IMPLEMENTATION.md`, and
`IMPLEMENTATION_STATUS.md` (see `.prettierignore`). Files with no Prettier
parser, such as `.env.example` and `docs/wol-poc.service`, are skipped by
`bun run format:check`.
