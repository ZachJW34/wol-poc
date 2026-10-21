# Wake-on-LAN app — single-agent implementation plan

## 1. Handoff and execution intent

- Revision: **WOL-1**, 2026-10-20.
- State: ready for review; product defaults approved in conversation, this implementation revision not yet approved for execution.
- Sources: the user's WoL requirements, the assistant's four recommended defaults, and the user's acceptance plus Docker request in this conversation.
- Repository baseline: branch `v2`, commit `fb2bf09b4a1e004860f1379c38dbe6975208e6f5` (`fresh start`), clean before this document was added.
- Observed files: `.env.example`, `.gitignore`, `.prettierignore`, `.prettierrc.json`, and an ignored `.env`. No application, manifest, tests, or existing implementation plan. Bun reports `1.4.2`. No applicable ancestor/project `AGENTS.md` was found. The real `.env` was not read and must not be overwritten.
- Existing example environment mentions an older app and broadcast overrides; the Prettier configuration mentions Svelte. Neither is a requirement for this new React application.
- **Execution is intentionally one agent, one implementation attempt. Do not delegate, spawn workers, or use the orchestration workflow.** P01–P05 below are sequential implementation phases/checkpoints for that same agent, not separate agent assignments. Read the whole document first, implement end-to-end, and verify before reporting completion.
- Keep this document as the contract. Record actual checks, remaining work, and environment limitations in a concise `IMPLEMENTATION_STATUS.md`; if interrupted, leave enough current-state information there to resume. Do not mark hardware checks passed without observing them.
- This is a plan only. No application scaffolding, dependency installation, Docker build, network change, or WoL command was performed while preparing it.

## 2. Product contract

The app is a small, private, mobile-friendly dashboard for saving LAN devices and requesting that the server wake them.

| ID | Observable requirement | Source |
| --- | --- | --- |
| R1 | React + TypeScript, Tailwind, a polished responsive UI using a small selection of shadcn/ui components. | Original stack/UI request; accepted defaults |
| R2 | Add a device using a name and MAC address; list, edit, and delete saved devices; retain them across restarts. | Original registration request; accepted CRUD/persistence default |
| R3 | Wake a saved device by POSTing to the server; the server runs the installed `wakeonlan` command with that saved MAC. | Original wake request and working command |
| R4 | Clearly distinguish pending, successful command submission, and failure. Success means “Wake request sent,” not “Device is online.” | Accepted feedback default |
| R5 | Support phone on Tailscale → host's Tailscale Serve HTTPS endpoint → loopback backend → LAN WoL packet. No app login. | Original topology; accepted access-control default |
| R6 | Bun is the package manager, application runtime, and backend test runner. Production uses one Bun application process for UI and API. | Original Bun/simplicity request; accepted deployment default |
| R7 | Provide a Linux Docker deployment with host networking and persistent SQLite storage, while retaining direct Bun execution. | Docker follow-up; accepted Linux default |
| R8 | Validate input on the server, prevent shell injection and browser cross-origin mutations, and do not expose secrets/database/source through static serving. | Safety necessary for the requested command-running app |
| R9 | Supply runnable verification and concise development, deployment, backup, and troubleshooting documentation. | Required implementation handoff/operability |

### Non-goals

No login/accounts, public Internet access/Funnel, device discovery, ping/online detection, scheduled wakes, bulk wake, wake history, remote shutdown, IP address fields, broadcast/port configuration, custom WoL packet implementation, WebSockets, SSR, router, ORM, distributed deployment, Kubernetes, or elaborate state-management framework. Docker Compose replaces the need for a systemd unit in this version; direct Bun operation is still documented.

No sample device is automatically registered. The MAC in the user's example is a test reference, not permission to wake it during implementation.

## 3. Architecture and proposed files

Use **React + Vite + Tailwind + shadcn/ui** for a client-rendered page, **Bun.serve** for HTTP, and **bun:sqlite** for persistence. Do not add Express/Hono, an ORM, or a separate production frontend server.

```text
Phone/browser -- HTTPS over Tailscale --> Tailscale Serve on Linux host
                                             |
                                    http://127.0.0.1:7123
                                             |
                            Bun server, directly or in host-network container
                               |                          |
                          SQLite file             spawn wakeonlan <saved MAC>
                                                          |
                                                  LAN UDP broadcast
```

Development uses a loopback Vite server on port 5173, proxying `/api` to Bun on port 7123. The browser always uses relative `/api/...` URLs. Production builds the client to `dist/`; Bun serves only those public build files and the API.

All application paths below are **proposed new files**, not existing conventions. Closely related small helpers may be combined; preserve the boundaries and contracts rather than creating abstractions for their own sake.

```text
src/shared/contracts.ts          Device/input/response types; pure input validation
src/server/config.ts             Parse and validate configuration
src/server/store.ts              SQLite initialization and parameterized CRUD
src/server/wake.ts               Safe, bounded subprocess adapter
src/server/app.ts                Request handler assembled from explicit dependencies
src/server/index.ts              Real process wiring, loopback bind, startup/shutdown
src/client/main.tsx              React entrypoint
src/client/App.tsx               Dashboard and ordinary component state
src/client/api.ts                Small typed fetch/error helper
src/client/components/           Device cards, device form, delete confirmation
src/client/components/ui/        Only the shadcn primitives actually used
src/client/styles.css            Tailwind imports and theme tokens
index.html                      Vite HTML entrypoint
vite.config.ts                  React/Tailwind setup, alias, dev proxy
tsconfig*.json, components.json  Type checking and shadcn setup as needed
tests/unit/                     Validation/config/store/wake tests
tests/integration/              HTTP, real SQLite, static-serving checks
tests/e2e/                      Playwright UI journeys
tests/fixtures/                 Isolated E2E server and harmless subprocess fixtures
playwright.config.ts            Local browser test setup
Dockerfile, compose.yaml        Linux production packaging
.dockerignore                   Exclude secrets/data/local artifacts
package.json, bun.lock          Commands and reproducible dependency versions
README.md                       Setup, operation, limits, troubleshooting
AGENTS.md                       Short verified architecture/commands/invariants guide
IMPLEMENTATION_STATUS.md         Implementation evidence and unfinished work
```

Prefer ordinary local React state and fetch. A small `useDevices` helper is fine if it improves clarity. Do not install a query/cache library solely for this screen. Use Lucide icons and a handful of shadcn primitives, not a dashboard template or a full component catalog.

### Dependency discovery and stop condition

In P01, choose mutually compatible published React, Vite, Tailwind, shadcn, and Bun types versions and commit `bun.lock`. Use Tailwind's Vite integration appropriate to the installed version; do not mix Tailwind 3 and 4 setup instructions. Run Vite under Bun explicitly if required. Bound compatibility investigation to a single focused setup attempt (roughly 20 minutes); if the basic build/typecheck cannot work, report the incompatible versions before extending the architecture. Do not introduce another framework or runtime to hide the failure. Likewise select a published Debian-based official `oven/bun` image and verify its tag during P05 rather than assuming a version-specific tag exists.

## 4. Boundary contracts

### C1 — Device and validation (P01 establishes; P02/P03/P04 consume)

```ts
type Device = {
  id: string;          // Server-created crypto.randomUUID(); immutable
  name: string;        // Trimmed, 1–80 JavaScript string code units
  mac: string;         // Canonical uppercase colon-separated MAC
  createdAt: string;   // Server-generated UTC ISO-8601 timestamp; immutable
};
type DeviceInput = { name: string; mac: string };
type ApiError = {
  error: {
    code: string;
    message: string;
    fields?: Partial<Record<"name" | "mac", string>>;
  };
};
```

- Accept only a JSON object with string `name` and `mac`; do not coerce null, numbers, arrays, or missing fields. Reject unexpected fields in create/edit bodies. Escape names through normal React text rendering, never HTML injection.
- Trim both fields. Accept six hexadecimal byte pairs with consistent colon separators or consistent hyphen separators; normalize to uppercase colons. Bare hex, mixed separators, extra arguments, and trailing text are invalid. Reject all-zero, all-FF, and multicast MACs (low bit of first byte set); locally administered unicast MACs are allowed.
- Examples: `{name: " Office PC ", mac: "c8-53-09-f8-8a-32"}` becomes name `Office PC`, MAC `C8:53:09:F8:8A:32`. Reject blank/81-character names, `C8:53:09:F8:8A`, `C8:53:09:F8:8A:32;id`, and `FF:FF:FF:FF:FF:FF`. Names of exactly 1 and 80 code units are valid after trimming.
- MAC is unique after normalization. Names need not be unique. Editing a device without changing its MAC must not conflict with itself.
- No IP/broadcast fields or client-supplied IDs/timestamps.

### C2 — SQLite persistence (P02 owns; P03 consumes)

One database file, one `devices` table: `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `mac TEXT NOT NULL UNIQUE`, `created_at TEXT NOT NULL`. Initialize with `CREATE TABLE IF NOT EXISTS`; use parameterized SQL, not string interpolation. Enable WAL with a modest busy timeout, create the database parent directory, and close the DB on process shutdown. No migration library is needed for this fresh schema.

The store exposes `list(): Device[]`, `get(id): Device | null`, `create(input): Device`, `update(id, input): Device | null`, and `remove(id): boolean`. Inputs are validated/canonical before writes; convert the unique constraint to a domain conflict, not a leaked SQL error. List in ascending `createdAt`, then `id` order. Create/edit/delete each commit before returning success. Failed mutations leave existing data unchanged. Reopening the same file retains data. Do not store DB files in `dist/`.

### C3 — HTTP API (P02 owns CRUD/security; P03 adds wake)

JSON request/response bodies, except 204. All `/api` responses use `Cache-Control: no-store`. Use the same error envelope for handled API errors; never expose stack traces, SQL, filesystem paths, or raw subprocess diagnostics.

| Method/path | Request | Success | Main failures |
| --- | --- | --- | --- |
| `GET /api/health` | None | 200 `{ "ok": true }` after successful startup | Process fails startup if config/DB cannot initialize |
| `GET /api/devices` | None | 200 `{ devices: Device[] }` | 500 unexpected failure |
| `POST /api/devices` | `DeviceInput` | 201 `{ device: Device }` | 400 validation/JSON; 409 duplicate MAC |
| `PATCH /api/devices/:id` | Complete `DeviceInput`, not a partial patch | 200 `{ device: Device }` | 400 validation; 404 missing; 409 duplicate MAC |
| `DELETE /api/devices/:id` | None | 204, no body | 404 missing |
| `POST /api/devices/:id/wake` | `{}` | 200 `{ status: "sent", deviceId: string }` | 404 missing; 409 already waking; 502 command failed; 503 command unavailable; 504 timeout |

Use error codes `VALIDATION_ERROR`, `INVALID_JSON`, `FORBIDDEN_ORIGIN`, `UNSUPPORTED_MEDIA_TYPE`, `DUPLICATE_MAC`, `NOT_FOUND`, `WAKE_IN_PROGRESS`, `WAKE_FAILED`, `WAKE_UNAVAILABLE`, `WAKE_TIMEOUT`, `METHOD_NOT_ALLOWED`, and `INTERNAL_ERROR` for the corresponding cases. Unsupported methods on known routes return 405; unknown API routes return JSON 404, never the SPA HTML. An arbitrary nonexistent ID is a 404; no need to distinguish malformed UUIDs from absent IDs.

For every mutating request, including DELETE and wake, require `Origin` to equal the configured `APP_ORIGIN` exactly; missing or different origin returns 403 before any mutation/spawn. JSON-bearing mutations require `Content-Type: application/json` (allow a charset parameter), otherwise 415. Invalid JSON returns 400. Require the wake body to be an empty JSON object. Do not enable CORS. CLI examples must include the Origin header; these checks are CSRF defenses, not authentication.

Static files: serve only an explicit set of files from the built `dist/` tree, preferably a startup file map of public URLs to files with the correct MIME types. Serve `/` as `dist/index.html`; this is a single page, so unknown paths may simply return 404. No generic project-directory file server or arbitrary `Bun.file(requestPath)`. Exclude hidden files and sourcemaps; `.env`, `.git`, source files, SQLite and sidecar files, encoded traversal attempts, and unknown assets must not be served. Production should fail with a useful startup message if its UI build is absent. Development may start the API without a built UI through an explicit development mode.

Assemble the request handler with an explicit store and wake function so tests can inject harmless dependencies. Keep listening and actual process creation in the entrypoint/adapters; importing modules must not start a listener or emit packets.

### C4 — Wake execution (P03 owns)

- Resolve the device from SQLite by URL ID; never accept a MAC, command, executable, broadcast address, or extra arguments in the wake request.
- Invoke **`Bun.spawn(["wakeonlan", device.mac], ...)`**, with no shell, no `sh -c`, and no command-string interpolation. In production the binary is always `wakeonlan` from the trusted server/image PATH, not configurable from a request.
- Discard or safely drain output; do not allow unbounded buffering or leak stderr into HTTP responses. Log a concise diagnostic server-side on failure without logging secrets.
- Await process exit. Exit code 0 returns `sent`; nonzero is 502; missing executable is 503. Bound the invocation to 5 seconds; kill and reap a timed-out child, return 504, and clear timers in every path. Do not automatically retry (a retry could emit another packet).
- Maintain an in-memory per-device in-flight set: simultaneous wakes of the same ID return 409, different IDs can proceed independently. Always clear the set in `finally`, including spawn failures and timeouts. A later deliberate click may send another packet.
- No DB transaction is held across subprocess execution. Resolve a snapshot before spawning; an edit/delete after that lookup does not cancel an already submitted wake.
- Only report that the command succeeded. Do not claim the target is awake, reachable, or online.

### C5 — Configuration and trust boundary (P01/P02 define; P05 packages)

| Variable | Contract |
| --- | --- |
| `PORT` | Default `7123`; validate integer 1–65535. Bind address is fixed to `127.0.0.1`, not public/configurable. |
| `APP_ORIGIN` | Browser origin only, no credentials/path/query/fragment. Required for production. HTTPS for Tailscale; HTTP permitted only for literal loopback development/local smoke origins. Explicit dev default `http://localhost:5173`. Store canonical `new URL(value).origin` and compare incoming Origin exactly. |
| `DATABASE_PATH` | Default `./data/wol.sqlite` for direct execution; `/data/wol.sqlite` in Docker. |
| `NODE_ENV` | `development` for explicit dev command, `production` for start/container, `test` for isolated fixtures. Never enable production fake-wake behavior. |

Do not consume old `HOST`, broadcast, or per-device override settings. Update `.env.example` and README to explain the replacement, but never change the user's `.env`. Configuration errors fail startup with actionable non-secret messages.

Tailscale authenticates network access and tailnet policy determines who may use the entire dashboard; all allowed visitors can edit/delete/wake every registered device. Origin validation is additional protection against malicious websites, not a replacement for Tailscale. Trust other local processes/users on the host. Do not accept spoofable identity headers as a new authentication system. No TLS termination inside Bun and no automatic Tailscale configuration changes.

### C6 — UI behavior and visual direction (P04 owns)

- One dashboard: restrained dark slate/zinc background, contrasting cards, one teal/emerald accent, crisp typography, Lucide device/power icons, subtle borders and spacing. Use a system font stack; no runtime font/CDN dependency. Polished but not animated or decorative for its own sake.
- Header has the app name, a short private-LAN description, and “Add device.” Main grid is one column on phones and expands on wider screens. Avoid a sidebar, charts, search, filters, and fabricated metrics. A compact device count is enough.
- Cards show name, readable monospace MAC, a prominent text-labelled Wake button, and accessible edit/delete actions. Do not show an online dot or invented last-awake timestamp.
- A shared add/edit dialog contains labelled name and MAC fields, format hint, inline errors, Cancel and Save. Preserve entered values on failure. Close on confirmed successful save; refresh/update the list from server-confirmed results. No optimistic success before the server commits.
- Delete requires a confirmation naming the device. Do not remove the card until the server confirms deletion. Network/API errors are visible and retryable, not silently swallowed.
- Wake button shows “Sending…” and is disabled for its pending request. Also disable edit/delete on that card while waking; leave other cards usable. Success toast/live feedback says **“Wake request sent”**, failure identifies the action and offers retry. Do not persist a misleading permanent “awake” state.
- Include initial loading, empty list with an Add CTA, list-fetch failure with Retry, form validation/conflict, and per-action loading/failure states. Never render a blank screen on an API error.
- Use native form semantics, focus-visible styles, accessible dialogs with focus return, an alert dialog for delete, labelled icon buttons, screen-reader announcements, and roughly 44px touch targets. Check keyboard-only use, reduced-motion preferences, and 360px width without horizontal scrolling.

### C7 — Docker/networking (P05 owns)

- Target **Docker Engine on a Linux LAN host**. Compose service `app` uses `network_mode: host`, `restart: unless-stopped`, a named volume mounted at `/data`, and no `ports:` mapping. The Bun listener remains `127.0.0.1:7123` in this mode; host Tailscale Serve can reach it.
- Host networking shares the host's network namespace so UDP broadcasts use the host network stack. A bridge-mode container may not deliver LAN broadcasts as intended. Do not quietly switch to bridge networking or bind `0.0.0.0` to fix connectivity.
- This is not a claim of verified packet delivery: host firewall, routing/multiple NICs, WoL firmware settings, and the LAN still matter. Docker Desktop and rootless Docker networking are outside the verified deployment target; do not promise equivalent broadcast behavior there.
- The host's installed command is **not** inherited by a container. Use a verified Debian-based official Bun image and install Debian's `wakeonlan` package in the runtime image. Do not mount the host binary or Docker socket. Normal UDP WoL needs neither privileged mode nor extra Linux capabilities.
- Use a straightforward multi-stage build: install locked build dependencies, build Vite assets, then copy server/shared source, production dependencies if any, and `dist/` into the runtime stage. No Vite dev server in the runtime image. Run the final container as a non-root user; arrange ownership so that the new named `/data` volume is writable. Do not make the host project world-writable.
- `.dockerignore` excludes `.env`, `.env.*` except a deliberate safe example if needed, `.git`, `data`, DB/sidecar files, `node_modules`, local `dist`, test artifacts, and unrelated local files. Copy only necessary runtime files; do not bake credentials or a populated DB into an image.
- Compose explicitly sets production configuration, maps `DATABASE_PATH=/data/wol.sqlite`, and requires `APP_ORIGIN` from the operator. Port remains 7123 unless deliberately changed along with Serve configuration. A healthcheck may use Bun's built-in fetch against loopback `/api/health`, without adding curl solely for that purpose.
- Tailscale runs on the **host**, not inside this image. README shows inspecting `tailscale serve status`, then (only if it will not replace an existing service) `tailscale serve --bg http://127.0.0.1:7123`. Set `APP_ORIGIN` to the exact HTTPS origin displayed by Serve. HTTPS certificates and appropriate tailnet grants/ACLs are host prerequisites. Do not enable Funnel or automatically reset/replace an existing Serve configuration.

## 5. Sequential implementation phases

All phases run from `/home/zachjw34/code/wol-poc`. Shared prerequisite: permission to implement this plan. Each phase owns its tests and supporting edits within the stated scope; do not rewrite unrelated files. If interrupted, update `IMPLEMENTATION_STATUS.md` with changed files, completed checks, failures, and the next action. Commands below are **proposed and unverified** until the application exists; P01 must establish their scripts. There are no existing test results to preserve or baseline failures to explain.

| Phase | Outcome | Depends on | Requirements | Readiness |
| --- | --- | --- | --- | --- |
| P01 | Buildable React/Bun baseline and shared contracts | None | R1, R6, R8, R9 | Eligible after approval; dependency compatibility checked here |
| P02 | Persistent add/list/edit/delete through the real HTTP handler | P01 | R2, R5, R6, R8 | Contract ready, implementation pending |
| P03 | Saved device → bounded safe wake command → honest response | P02 | R3, R4, R8 | Contract ready, implementation pending |
| P04 | Polished, accessible end-to-end device dashboard | P02, P03 | R1–R4, R8 | Contract ready, implementation pending |
| P05 | Container deployment, documentation, final verification | P01–P04 | R5–R9 | Docker/hardware checks require appropriate host access |

### P01 — Buildable shell and explicit contracts

1. Read repository baseline, sections 2–3, C1/C5, and the existing ignore/format files. Do not run a scaffolder over the current directory or erase existing work; add the necessary files deliberately.
2. Own manifest/lockfile, TypeScript/Vite/Tailwind/shadcn configuration, client entry shell, shared types/validation, config parser, and their unit tests. Replace the stale Svelte-only Prettier plugin configuration with a minimal React/TS-compatible configuration when introducing actual tooling; adjust ignore files narrowly as needed.
3. Establish scripts: `dev` (Bun API development plus loopback Vite with clean shutdown), `build` (Vite production client build), `start` (Bun production entrypoint), `typecheck` (all client/server/shared/test TS configurations), `test` (`bun test tests/unit tests/integration`), `test:e2e` (Playwright only), and `format:check` (Prettier check). Avoid a separate lint stack solely for this app.
4. A small Bun development launcher is acceptable; ensure it cleans up both child processes and fixes Vite to 5173 rather than silently switching ports. Do not proxy development traffic through Tailscale by default.
5. Acceptance: the React shell renders with real Tailwind styling; contracts compile; validation/config boundary tests pass; a production frontend build succeeds. No production API assumptions are replaced with permanent mock data.
6. Verify: `bun install`, `bun run typecheck`, `bun run test`, `bun run build`. At this phase `dev`/`start` can be completed in P02, but the build and test baseline must actually run before proceeding. Record selected versions.
7. Stop for dependency incompatibility that exceeds the bounded discovery attempt or conflict with existing user files; do not replace the product stack. Do not add unrelated features.

### P02 — Persistent CRUD and protected HTTP boundary

1. Read C1–C3/C5 and P01's contracts/config; no need to reinterpret architecture.
2. Own store, HTTP handler, server entrypoint/static serving, integration tests, and necessary dev-script wiring. Build the true early slice: request → validation → real temporary SQLite → response. The client shell from P01 may remain simple until P04.
3. Implement CRUD, schema initialization, unique MAC handling, origin/content-type protections, error mapping, loopback binding, and safe production static serving. Startup/DB failures must not quietly fall back to an in-memory database or empty list.
4. Acceptance tests: empty/create/list/edit/delete; normalization and duplicate conflict including edit-to-self; missing ID; malformed/non-object JSON; wrong content type; missing/wrong origin; forbidden requests never alter DB; SQL-like name treated as text; data survives DB close/reopen; failed writes preserve existing values; health and unknown API routes; unknown methods; allowed static HTML/assets but no sensitive/traversal/source paths.
5. Verify: `bun test tests/unit tests/integration`, `bun run typecheck`, `bun run build`. Use handler-level `Request` tests with a real temp DB; add at least one real loopback HTTP smoke test, never a public bind.
6. First integration checkpoint: the handler can create and retrieve a registered device using the production store implementation. P03 extends this slice with the external command, P04 exposes it through the finished UI.
7. Stop if persistent storage cannot be safely opened or a real network restriction prevents the smoke test. Fix ordinary code failures; report environmental ones without bypassing security.

### P03 — Safe wake behavior and subprocess evidence

1. Read C3/C4 and P02 handler injection/store APIs.
2. Own wake adapter, wake route integration, and unit/integration tests. Do not change the device schema or invent broadcast options. Inject a harmless runner into handler tests; keep production wiring real.
3. Acceptance: a saved device's canonical MAC becomes exactly the second argument after `wakeonlan`; success waits for zero exit. Nonzero, unavailable command, timeout, duplicate in-flight wake, and post-failure retry map to C3. Unknown ID, wrong Origin, or malicious request body never invokes the runner. Independent devices are not unnecessarily serialized.
4. Test the **real subprocess adapter** using a harmless fixture executable injected through its internal test dependency (not an HTTP/config feature). Capture argv, simulate exit failure and a hanging process, prove timeout termination/reaping and cleanup. An HTTP mock alone does not prove shell-safe process creation.
5. Verify: `bun test tests/unit tests/integration`, `bun run typecheck`. All automated tests must be incapable of waking actual LAN equipment; do not call the user's sample MAC or depend on an installed real CLI in tests.
6. Stop if Bun subprocess/timeout behavior cannot be demonstrated with the fixture. Do not replace the adapter with a success-returning stub, shell string, or custom UDP implementation.

### P04 — Finished dashboard and browser verification

1. Read C1/C3/C6 and the existing client shell. Use actual API contracts rather than reproducing validation rules inconsistently.
2. Own client API/components/styles, Playwright setup, browser journeys, and a test-only E2E entrypoint. Keep production composition free of fake-wake toggles.
3. Implement the complete responsive dashboard and all form/list/action states. The initial shell is not the final visual design: pay attention to hierarchy, spacing, empty states, touch use, focus, contrast, and clear copy.
4. E2E server uses the real handler/store with a temporary DB and an injected harmless wake function in `tests/fixtures/`; isolate it on loopback test ports and clean it up. Tests must never point at the user's production DB or server. Test-only code is not copied into the runtime image.
5. Browser journeys: add normalized device → reload and see persistence → edit → wake and see exact honest success copy → confirm delete; duplicate/invalid field errors; simulated server/network wake failure leaves device usable; initial fetch failure and retry; cancel delete; keyboard dialog open/close/focus return. At least one mobile viewport assertion (360px) and one desktop view. Use controlled test fixtures/request interception for browser failure cases; backend error mapping is verified separately in P02/P03.
6. Verify: `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:e2e`. Playwright Chromium installation is an explicit prerequisite (`bunx --bun playwright install chromium`; Linux may also need OS browser dependencies). If the environment cannot launch a browser, report that blocker and do not call screenshots/E2E verified. Check the real desktop/mobile rendering when browser tools are available.
7. Stop for actual accessibility/flow regressions or contract conflicts; do not add unrelated UI features to compensate. Missing browser system dependencies are a verification limitation, not permission to remove the browser checks.

### P05 — Linux Docker operation and whole-product acceptance

1. Read C5/C7, completed app commands, and all remaining acceptance items. Own Docker files, `.dockerignore`, `.env.example`, README, concise new AGENTS.md, status evidence, and narrowly necessary deployment fixes.
2. Build a non-root runtime image containing Bun, built UI, real server, and installed `wakeonlan`. Verify a published base tag and record it. Check the named volume is writable as the runtime user; do not solve permission issues with privileged mode or broad chmod.
3. README includes: prerequisites; Bun dev/build/start; exact origin settings for dev versus HTTPS deployment; Compose host-network rationale; Tailscale host setup/status and no Funnel; CRUD/wake semantics; full checks; restart/upgrade; stopped-service database backup/restore; and troubleshooting for missing CLI, wrong origin, DB permissions, no WoL despite command success, multi-NIC routing, and Docker host networking constraints.
4. AGENTS.md is a short verified guide to architecture, commands, security invariants, test entrypoints, and deployment pitfalls—not a copy of this plan or an agent transcript.
5. Run the final command matrix below. Do not mutate the user's live Tailscale configuration or wake hardware merely to finish the plan. If those require access/permission not provided, leave explicit pending operator checks and report “implemented; hardware/network acceptance pending.”
6. Stop if Docker/daemon/network access is unavailable, the runtime cannot write its volume, or the image cannot install/run the CLI. Document the exact limitation; do not claim container operation based only on reading the Dockerfile.

## 6. Verification and evidence

### Automated/local gates

Commands are proposed for the new project, not commands run during planning. Run from the repository root, after P01 defines scripts. Record command, outcome, and any environment limitation in `IMPLEMENTATION_STATUS.md`.

| Command | Prerequisite / expected evidence |
| --- | --- |
| `bun install --frozen-lockfile` | Committed lockfile; repeatable install without lockfile changes. |
| `bun run typecheck` | Client, server, shared, and tests pass strict TS checking. |
| `bun run test` | All Bun unit/integration tests pass; no real WoL packets emitted. |
| `bun run build` | Actual production HTML/CSS/JS generated in `dist/`. |
| `bun run format:check` | Implemented source/config/docs pass agreed formatting; use a local format script once if needed, not ignored failures. |
| `bun run test:e2e` | Chromium prerequisites; isolated desktop/mobile journeys pass. |
| `docker compose config --quiet` | Docker Compose installed and `APP_ORIGIN` set to an origin appropriate to that check. |
| `docker compose build` | Docker available; runtime includes built app and real `wakeonlan`. |
| `docker compose run --rm --no-deps app sh -c 'id -u; command -v wakeonlan; test -w /data'` | Image built; inspect output: nonzero UID, real CLI path, writable volume. This shell is an operator diagnostic, never request-driven execution. |
| `docker compose up -d` | Linux host; chosen port free; proper origin configured; non-root service starts. |
| `curl --fail http://127.0.0.1:7123/api/health` | Running direct/container service; 200 JSON with `ok: true`. |

Additional deployment smoke evidence: fetch `/` and a built asset with correct content types, create a disposable device through the API with the correct Origin header, recreate the container without deleting its volume, confirm the device remains, and delete it. Wrong/missing origin must fail without mutation. Check `ss -ltn` to confirm the app listens only on `127.0.0.1:7123`. Verify runtime files/build context do not expose `.env` or a populated DB. Stop a service before backing up the whole SQLite data directory (including sidecars); never suggest copying only a live WAL-mode `.sqlite` file.

Avoid `docker compose down -v`; it destroys the persistent data volume. Do not stop/reconfigure an existing service to free a port without operator approval. Environment-specific startup examples must explain port conflicts rather than silently changing endpoints.

### Manual/hardware acceptance — operator permission required

1. On the actual Linux LAN host, establish that `wakeonlan <an operator-approved device MAC>` works outside Docker. Do not execute this automatically during implementation.
2. Start the host-network container and access the dashboard through host Tailscale Serve. Confirm the displayed URL origin matches `APP_ORIGIN`, and inspect Serve/Funnel status and tailnet access policy. No app login is expected.
3. From a phone on cellular data with Tailscale enabled, add an approved device, power it down normally, tap Wake, and observe **both** “Wake request sent” in the UI and the physical device actually waking. This is the decisive test that Docker, routing, LAN, firmware, and Tailscale topology work together.
4. Confirm edit/delete work from the phone; reload and restart/recreate the container and verify persistence. Confirm unauthorized network access is denied according to the operator's tailnet policy; the dashboard is not unintentionally available through Funnel or a public listener.
5. If the command exits 0 but hardware does not wake, report the distinction. Diagnose the LAN route/firewall/NIC and compare the host and container CLI execution. Do not fake online status, add privileged mode, or silently add broadcast overrides to claim success.

Mocks/fixtures establish application behavior; only these real-network observations establish actual remote wake success. If the deployment machine or test target is unavailable, document these checks as pending.

## 7. Coverage and completion rule

| Requirement | Owner phases | Evidence |
| --- | --- | --- |
| R1 | P01, P04 | Build/typecheck, desktop/mobile browser rendering and accessibility checks |
| R2 | P02, P04, P05 | Real SQLite CRUD/reopen tests, UI journey, container recreation persistence |
| R3 | P03, P05 | Captured subprocess argv/exit behavior; operator real-device wake |
| R4 | P03, P04 | Error/timeout tests, pending UI and exact honest success feedback |
| R5 | P02, P05 | Loopback bind, Origin tests, phone → Tailscale Serve manual acceptance |
| R6 | P01, P02, P05 | Bun scripts/tests/build/start; one production app process |
| R7 | P05 | Successful non-root image/Compose smoke, CLI presence, persistent volume, real host-network wake |
| R8 | P01–P05 | Input/SQL/origin/static-path tests, safe argv fixture, secret exclusions, deployment review |
| R9 | P01–P05 | Passing command matrix and accurate README/AGENTS/status with limitations |

The three easiest mistakes to avoid are: (1) installing `wakeonlan` only on the host rather than inside the image; (2) using Docker bridge networking or a public listener to “fix” access; (3) treating exit code 0 as proof the device is online. C4/C7 and the manual checks are explicit about all three.

Completion requires real implementation, clean automated gates where supported, accurate operational docs, and evidence rather than assertions. A concise final report lists what works, commands actually run, and pending environment/hardware checks. Do not claim full deployment validation if Docker, browser, Tailscale, or real WoL tests were not available. No architectural/product questions remain blocking code implementation; runtime dependency compatibility is checked in P01 and actual Docker/LAN delivery remains an explicit operational acceptance check.
