# WoL web app — implementation handoff

## Current revision — `wol-cli-default-r2`

User authorized updating this plan and executing the simplification via Strata.
The r1 handoff below is historical; the r2 amendment in section 8 supersedes its
global broadcast requirement, fixed `-i` argv, and associated UI/config wording.
All other r1 contracts remain unchanged. Progress/evidence lives in
`IMPLEMENTATION_STATUS.md`.

## Handoff

- Revision: `wol-mvp-r1`, prepared 2026-10-18.
- State: ready for implementation-plan approval; execution not yet authorized.
- Source: `docs/plan.md`, especially Confirmed requirements, Proposed MVP scope,
  CLI integration, Access and safety, and Acceptance criteria.
- User clarification: manual-registration MVP approved; everyone permitted by
  the existing Tailscale policy may manage all devices without an app login;
  access is through an existing Tailscale Serve/HTTPS proxy to a loopback backend.
- Baseline: repository contains only `docs/plan.md`; no application, package
  manifest, tests, lockfile, or project instructions were present on inspection.
  The workspace is not a Git repository. No application checks have run.
- All application paths below are proposed, not existing files. All commands
  involving those files are proposed and unverified until their owner packet runs.
- Preserve `docs/plan.md`. No Tailscale changes, real wake commands, deployment,
  or commits are authorized by this document alone.
- After approval, use `strata-orchestration` with this revision. Maintain progress
  separately in `IMPLEMENTATION_STATUS.md`.

## 1. Product contract

Requirement IDs below map source intent to acceptance evidence. Technical details
later in this document are proposed decisions for approval with this revision.

| ID | Observable requirement | Source anchor |
| --- | --- | --- |
| R1 | One Bun runtime serves a Svelte app and same-origin API behind the existing private HTTPS proxy | Goal; Stack; user clarification |
| R2 | Users can list, register, edit, and delete named devices with MAC and optional broadcast override | Device management; HTTP API |
| R3 | Registrations and last successful command times survive restart | Device management; Wake action |
| R4 | Wake requests invoke installed wakeonlan for a saved device, with separate validated arguments and effective broadcast address | CLI integration |
| R5 | UI supports phones, empty/loading/error states, forms, deletion confirmation, and explicit pending/success/failure wake feedback | Proposed MVP scope |
| R6 | Invalid inputs and unknown devices never start a command; concurrent/repeated wakes respect a per-device cooldown | CLI integration; Acceptance criteria |
| R7 | CLI failure and timeout terminate cleanly, return sanitized errors, and do not falsely advance the sent timestamp | CLI integration; Wake action |
| R8 | Access stays private, uses existing Tailscale authorization, and rejects cross-origin mutations without permissive CORS | Access and safety; user clarification |
| R9 | Automated tests cover persistence, API, process boundary, concurrency, and important UI flows without waking hardware | Delivery sequence; Acceptance criteria |
| R10 | Production startup is documented and verified; an authorized phone-to-server smoke test records packet-sent and observed boot behavior separately | Delivery sequence; Acceptance criteria |

Non-goals: discovery, online/offline detection, boot confirmation, schedules,
batch wake, shutdown, custom UDP, multiple agents, public exposure, app accounts.
Do not introduce queues, SvelteKit, a separate database service, or a new proxy.

## 2. Architecture and decisions

Use TypeScript throughout; Svelte 5 with Vite; `Bun.serve`; `bun:sqlite`.
Use current compatible stable package versions at bootstrap and commit Bun's
lockfile to the project files (do not make a Git commit). Bun's installed version
must support the selected tooling; record the verified version in README.
Do not guess package versions or silently upgrade an incompatible runtime.

```text
src/shared/contracts.ts     JSON-facing types and error codes
src/server/config.ts        validated environment configuration
src/server/devices.ts       validation + SQLite device repository
src/server/runner.ts        bounded subprocess execution
src/server/wake.ts          cooldown and wake orchestration
src/server/app.ts           injectable Request -> Response handler
src/server/index.ts         production wiring, Bun.serve, shutdown
src/web/                    Svelte entry, UI, API client
tests/server/               Bun test suites
tests/e2e/                  Playwright browser tests
dist/                      generated frontend; never store persistent data here
```

Keep modules small; split helpers locally when needed within packet ownership.
Public contracts below are fixed across packets; ordinary private helper design
belongs to the worker. Do not create elaborate generic frameworks.

Build a thin production-served device list before finishing all backend features.
Then implement storage/API, wake behavior, and full UI incrementally. Run packets
sequentially: several intentionally share the API composition and frontend files.

### Environment contract (owner P01; implemented P02/P03/P08)

| Variable | Rule |
| --- | --- |
| `HOST` | Optional; default `127.0.0.1`; production accepts only `127.0.0.1` or `::1` for the approved proxy arrangement |
| `PORT` | Optional; default `3000`; integer 1–65535 |
| `APP_ORIGIN` | Required; one origin-only HTTPS URL, no credentials/path/query/fragment; loopback HTTP origin permitted only for explicit development/test configuration |
| `WOL_BROADCAST_ADDRESS` | Required IPv4 default; operator supplies a known working address, never infer a subnet |
| `DATABASE_PATH` | Optional; default `./data/wol.sqlite` resolved from process working directory; reject paths inside dist or other served assets |

Use constant five-second command timeout and five-second cooldown; no runtime
configuration knobs needed for v1. Tests inject time and runner behavior.
The CLI executable is the literal `wakeonlan` resolved from the service PATH.
No HTTP-supplied executable, environment, timeout, or extra arguments.

Fail startup with an actionable configuration error before listening when
configuration is invalid. A missing executable must also fail production startup;
runtime command failures still need handling. Do not log secrets or full bodies.
Use a documented systemd WorkingDirectory and a writable persistent database path.

## 3. Contracts

### C1 — Device JSON, validation, and persistence (owner P03)

```ts
type Device = {
  id: string;                     // server-generated UUID
  name: string;
  macAddress: string;             // uppercase colon-separated
  broadcastAddress: string | null;
  lastWakeSentAt: string | null;   // UTC ISO timestamp
};
type CreateDevice = {
  name: string;
  macAddress: string;
  broadcastAddress?: string | null;
};
type UpdateDevice = Partial<CreateDevice>;
```

- Trim names; require 1–80 Unicode code points after trimming; reject control
  characters. Names need not be unique and are rendered as text, never HTML.
- MAC input: exactly six hexadecimal octets with consistent colon or hyphen
  separators; trim outer whitespace, normalize to uppercase colons. Reject
  all-zero, all-FF, and multicast MACs (low bit of first octet set).
- Reject duplicate normalized MACs, including on edit, with HTTP 409. Enforce
  uniqueness in SQLite, not only a pre-insert check.
- Broadcast: trim and require exactly four decimal octets 0–255, no leading
  zeros except `0`; reject `0.0.0.0` and multicast 224.0.0.0/4. Permit directed
  broadcasts and `255.255.255.255`. Syntax cannot prove subnet correctness.
- On create, omitted/null broadcast means server default. On patch, omission
  preserves the value and null clears the override. Empty string is invalid;
  the UI converts an empty broadcast field to null.
- Reject unknown keys, non-object JSON, null required fields, wrong types, and
  empty patches. Clients cannot set id or lastWakeSentAt.
- Device list order: name ascending using SQLite binary collation, then id.
- SQLite migration/init creates one devices table with the fields above, MAC
  uniqueness, and a schema version. Store nullable ISO strings for timestamps.
  Use parameterized statements; create the data directory safely. Close the
  database on shutdown and in tests. No network calls inside transactions.
- Example: `{ "name": " Desk ", "macAddress": "02-aa-bb-cc-dd-ee" }`
  yields name `Desk`, MAC `02:AA:BB:CC:DD:EE`, null override and null timestamp.

Repository API consumed by app/wake; synchronous SQLite operations:

```ts
interface DeviceRepository {
  list(): Device[];
  get(id: string): Device | null;
  create(input: CreateDevice): Device;
  update(id: string, input: UpdateDevice): Device;
  delete(id: string): void;
  recordWakeSent(id: string, sentAt: string): void;
  close(): void;
}
```

Missing update/delete throws the shared `NOT_FOUND` application error; conflicts
throw `CONFLICT`. Validation throws `VALIDATION_ERROR`. Unexpected storage errors
map to sanitized `INTERNAL_ERROR`; never return SQL or database paths.

### C2 — HTTP boundary (types P01; handlers P02/P04/P06)

All API responses except 204 are JSON. Set `Cache-Control: no-store` on API
responses. An error is `{ "error": { "code": "...", "message": "..." } }`;
429 additionally includes `retryAfterMs` inside error and a whole-seconds
`Retry-After` header rounded up. No raw process output in responses.

| Request | Success |
| --- | --- |
| GET `/api/devices` | 200 `{ "devices": Device[] }` |
| POST `/api/devices` | 201 `{ "device": Device }` |
| PATCH `/api/devices/:id` | 200 `{ "device": Device }` |
| DELETE `/api/devices/:id` | 204, no body |
| POST `/api/devices/:id/wake` | 200 `{ "device": Device, "message": "Wake packet sent" }` |

Codes: `VALIDATION_ERROR` 400; `FORBIDDEN_ORIGIN` 403; `NOT_FOUND` 404;
`METHOD_NOT_ALLOWED` 405 (include Allow); `CONFLICT` 409; `PAYLOAD_TOO_LARGE` 413;
`UNSUPPORTED_MEDIA_TYPE` 415; `WAKE_COOLDOWN` 429; `INTERNAL_ERROR` 500;
`WAKE_FAILED` 502; `WAKE_TIMEOUT` 504. Unknown API routes return JSON 404,
not frontend HTML. Unsupported methods on recognized routes return 405.

Require an Origin header equal to configured APP_ORIGIN for every POST/PATCH/
DELETE, including bodyless wake/delete. Reject absent, `null`, or foreign origins
before any mutation or command. Do not trust forwarded headers to derive it.
GET remains readable; no CORS allow headers are emitted. No mutation on GET.

For create/patch require application/json (optional charset), enforce 8 KiB
maximum actual body bytes even when Content-Length is absent or misleading, and
reject malformed JSON. Wake/delete have no body contract: accept empty bodies,
reject nonempty bodies with 400 (413 if over the same limit). Static responses
must not expose data, source files, dotfiles, or traversal targets.

### C3 — Runner and wake state (runner P05; service P06)

```ts
type CommandResult =
  | { kind: "ok" }
  | { kind: "failed" }
  | { kind: "timeout" };
type RunWakeCommand = (input: {
  macAddress: string;
  broadcastAddress: string;
}) => Promise<CommandResult>;
```

Production runner uses `Bun.spawn` with exactly
`["wakeonlan", "-i", broadcastAddress, macAddress]`, without shell expansion.
Exit zero is ok; nonzero/spawn errors are failed. Timeout after 5 seconds kills
the process, waits for exit, and returns timeout. Drain stdout/stderr concurrently;
retain at most 8 KiB diagnostic data combined and discard excess without letting
pipes block. Clean up timers, streams, and child processes on every path.
Diagnostics may be logged internally in bounded form, never put in HTTP errors.

Tests exercise real process handling with harmless test subprocesses through a
private injected spawn seam. That seam is not exposed through API/config. No
automated test may call the real wakeonlan executable or send a magic packet.

Wake service exposes `wake(id): Promise<Device>` and `isBusy(id): boolean`.
Dependencies: DeviceRepository, RunWakeCommand, default broadcast, injectable
monotonic milliseconds clock plus wall-clock timestamp provider.

For a known device, synchronously reserve its per-device slot before the first
await. Reject any in-flight duplicate with 429, even if a deadline has elapsed.
After completion, release in-flight state but retain a five-second cooldown
starting at completion on both success and failure. This bounds retry bursts;
different device IDs may proceed independently. Cooldown lives in memory for
this single process and resets on restart; persistent timestamps do not reset.

For in-flight 429 use retryAfterMs=5000; otherwise use remaining monotonic cooldown.
Unknown devices return 404 without invoking the runner. On success record the
wall-clock UTC time after command exit and return the updated device. Failure or
timeout preserves the prior timestamp. A persistence failure after successful
execution returns INTERNAL_ERROR without retrying the command; log that packet
sending may have occurred. Always release in-flight state in finally.

Serialize registration edits/deletion against an in-flight wake: PATCH/DELETE
for that device returns 409 CONFLICT while isBusy is true; it can proceed during
the post-completion cooldown. No overlapping update may change wake arguments
mid-command. This rule relies on one Bun process and synchronous repository calls;
multi-process scaling is out of scope.

### C4 — Browser behavior (thin list P02; full UI P07)

- Same-origin relative `/api` fetches; no token/account UI. Mutation fetches let
  the browser set Origin; no attempt to set it manually.
- On load show loading, then list or empty state; failure shows a retry action.
- Device cards show name, MAC, broadcast override or "Server default", and
  last sent time or "Never sent". Do not claim reachability/boot status.
- Wake button is pending/disabled per device during the request. Show exact
  success label "Wake packet sent"; refresh that device's timestamp from response.
  On failure show a safe message; on 429 honor retryAfterMs before reenabling.
  Server enforcement remains authoritative across tabs.
- Add/edit forms mirror validation rules, label fields, and show server validation
  and duplicate errors without losing inputs. Empty broadcast means null.
- Confirm deletion; cancel does nothing. Pending edit/delete errors preserve the
  device and show feedback. Disable editing/deleting a locally waking device;
  handle server 409 when another client has initiated a wake.
- Use accessible labels/buttons, keyboard operation, visible focus, and a live
  status region. At a 390px viewport no horizontal scrolling or hover-only actions.
  Plain responsive CSS; no component library required.

## 4. Verification strategy

Root working directory for all commands: `/home/zachjw34/code/wol-poc`.
P01 owns exact scripts; later packets may extend test contents but must not
weaken scripts. Proposed scripts:

| Command | Intended implementation and success |
| --- | --- |
| `bun run check` | svelte-check plus TypeScript checking of frontend, server, shared types and test code; zero diagnostics |
| `bun run test:server` | `bun test tests/server`; all isolated server tests pass |
| `bun run build` | `vite build`; generated frontend in dist |
| `bun run test:e2e` | `playwright test`; mobile Chromium flows pass with no hardware calls |
| `bun run start` | `bun src/server/index.ts`; validates config and serves production build |
| `bun run format:check` | Prettier check with Svelte plugin on owned source/config/docs; no formatting violations |

Do not reformat the user source `docs/plan.md` or this approved handoff as incidental
cleanup. Define formatter inputs/ignores accordingly. No separate lint framework
is required for this small app; type checks, tests, and formatting are the gates.

P01 may install project packages after execution approval. Browser installation
may require downloading Playwright Chromium; report an unavailable download or
OS dependency as an environment blocker, not a passing check. No global tooling,
system packages, proxy settings, or systemd installation without authorization.

Browser harness starts the actual Bun HTTP application on an available loopback
test port with a temporary database and injected fake runner. Its trusted Origin
is that loopback test origin. The fake runner is wired only by a test entry point
under tests, never by a production environment flag or HTTP control endpoint.
Use process/fixture-local configuration to choose deterministic success/failure
scenarios. Integration assertions check saved API data as well as UI feedback.

Production binary/flags are verified later without sending packets. Hardware and
phone tests remain manual and explicitly gated. A mock cannot satisfy R10.

## 5. Packet map

All packets await approval of r1. Readiness below is relative to that approval.

| ID | Outcome | Dependencies | Requirements | Readiness |
| --- | --- | --- | --- | --- |
| P01 | Compatible toolchain, scripts, and shared types | none | R1, R9 | first eligible; runtime/package availability to verify |
| P02 | Built Svelte page lists devices through real Bun HTTP | P01 | R1, R5, R8, R9 | after P01 |
| P03 | Validated persistent device repository | P01 | R2, R3, R6, R9 | after P01; sequential after P02 recommended |
| P04 | Safe CRUD API with persistence | P02, P03 | R2, R3, R6, R8, R9 | after dependencies |
| P05 | Bounded, tested subprocess runner | P01 | R4, R7, R9 | after P01; sequential after P04 recommended |
| P06 | Wake API with concurrency and timestamp rules | P04, P05 | R3, R4, R6, R7, R9 | after dependencies |
| P07 | Full mobile device-management and wake UI | P06 | R2, R5, R9 | after P06 |
| P08 | Production wiring, runtime documentation, integration checks | P07 | R1, R3, R8, R9, R10 | after P07 |
| P09 | Final real phone/proxy/wake acceptance | P08 | R10 | blocked on operator configuration and explicit live-test authorization |

P02 is the first end-to-end slice. It uses an injected empty list rather than
pretending persistence exists; P04 replaces it with the real repository.

### Rules common to every packet

Read this handoff's relevant contracts, `docs/plan.md`, and existing files before
editing. Preserve stable types and previously accepted behavior. Only alter the
listed subsystem/files; report necessary out-of-scope changes before making them.
New test helpers within the assigned test scope are allowed. P01 owns manifests
and lockfile; later dependency changes require orchestrator approval.

Each completion report must give changed files, acceptance criteria met/unmet,
decisions, exact commands and exit outcomes, and remaining blockers. Stop on an
unresolved contract conflict, unavailable required runtime, or missing prerequisite;
do not weaken requirements or substitute an implementation stack.

## P01 — Establish a verifiable project baseline

- Goal: establish compatible Bun/Svelte/TypeScript tooling and C2/C3 shared types.
- Context: no application files exist. Read sections 2–4 before choosing versions.
- Scope: package.json, bun.lock, TypeScript/Vite/Svelte/Playwright/Prettier config,
  .gitignore, root index.html, src/shared/contracts.ts, minimal src/web entry and
  App.svelte, tests/server/contracts.test.ts, tests/e2e baseline harness, and a
  README toolchain section. Do not create API/storage/wake behavior.
- Contract: all section 4 scripts except start may be functional now; start's
  target is explicitly introduced P02. Use Bun test for server and Playwright
  Chromium for UI. Export Device, request types, error envelope/codes, and
  CommandResult/RunWakeCommand without duplicate cross-module definitions.
- Acceptance: install compatible packages with a lockfile; build a minimal page;
  type-check all planned source domains; non-vacuous contract and page-render
  tests pass; record actual runtime versions. Establish a test-only server harness
  appropriate for the initial Vite page, to be replaced by Bun HTTP in P02.
- Verification (proposed): `bun --version`, `bun install`, `bun run check`,
  `bun run test:server`, `bun run build`, `bun run test:e2e`,
  `bun run format:check`. Chromium download is allowed only as a project test
  dependency; no OS/global installation.
- Stop: unavailable Bun, incompatible package set needing runtime upgrade, or
  unavailable browser dependencies. Record partial checks rather than inventing
  success. Do not initialize Git or create a service.

## P02 — First HTTP-to-Svelte list slice

- Goal: serve the built page from Bun and list an injected empty device array.
- Scope: src/server/config.ts, app.ts, index.ts; src/web API client/App.svelte;
  tests/server/http.test.ts; tests/e2e list smoke and test-server harness.
- Contracts: C2 GET list envelope; config rules in section 2; injectable handler
  composition suitable for adding repository and wake service later. Initial
  list dependency returns []; do not claim it is persistence. Unknown /api paths
  return JSON 404. Static serving is rooted at dist; GET/HEAD only, traversal and
  dotfiles denied; root index and actual assets work, missing assets return 404.
  App has no client-side route requirement, so no catch-all HTML fallback needed.
- Acceptance: Bun serves a built Svelte page, browser fetches /api/devices, and
  accessible empty state appears. UI has load-error/retry support using a fake
  failing list dependency in a separate test scenario. Backend never serves
  database files or application source. Missing build fails production startup
  clearly. Startup wiring need not resolve the CLI until P08.
- Verification: `bun run check`, `bun run test:server`, `bun run build`,
  `bun run test:e2e`, `bun run format:check`. Browser harness now starts actual
  Bun server with injectable list, not Vite's development server.
- Stop: framework-specific routing behavior would require changing API contracts
  or opening a non-loopback test listener. Do not add a frontend server runtime.

## P03 — Validate and persist device registrations

- Goal: implement C1 with SQLite and unit tests, without exposing mutation routes.
- Scope: src/server/devices.ts and tests/server/devices.test.ts; schema/init code
  may be colocated or split within src/server/db*.ts.
- Dependencies: shared C1/C2 types from P01. No changes to HTTP/UI necessary.
- Acceptance: create/list/get/update/delete, normalized uniqueness, all specified
  validation, nullable overrides and timestamps, and timestamp write work. Test
  Unicode/control names, MAC separators/reserved MACs, IPv4 bounds, patch semantics,
  duplicate edits, not-found, SQL-like input as data, and deterministic list order.
  Close/reopen a real temporary database to prove persistence; isolated tests
  must not write to the runtime data directory. Migration/init is repeatable.
- Verification: `bun test tests/server/devices.test.ts`, `bun run check`,
  `bun run test:server`, `bun run format:check`.
- Stop: persistence API cannot satisfy a contract without changing shared types.
  No speculative ORM, migration framework, or new runtime dependency.

## P04 — Safe CRUD endpoints

- Goal: connect the repository to the HTTP boundary and production list wiring.
- Scope: src/server/app.ts, index.ts, optional src/server/http.ts; server CRUD/
  security tests; list e2e fixtures. No complete forms or wake endpoint yet.
- Contracts: C1/C2 including origin checks, actual-byte size limits, content-type,
  structured errors, method dispatch, and no-store. Introduce an injected busy
  predicate defaulting false; P06 supplies wake.isBusy for edit/delete protection.
- Acceptance: all CRUD routes match envelopes/statuses and persist across app
  reconstruction. Rejected origin, malformed input, body overflow including no
  Content-Length, unknown routes/methods, duplicate MACs, and internal failures
  behave as specified. API errors never render the SPA or leak internals.
  Nonempty injected list renders names as text, including HTML-like names.
- Verification: `bun run test:server`, `bun run check`, `bun run build`,
  `bun run test:e2e`, `bun run format:check`.
- Stop: origin/proxy assumptions disagree with approved deployment model. Do not
  trust forwarded host/origin headers or add permissive CORS to fix tests.

## P05 — Safely run the installed CLI

- Goal: implement C3's process runner independently of HTTP/cooldown.
- Scope: src/server/runner.ts, tests/server/runner.test.ts, harmless process fixture
  scripts under tests/fixtures/. No real wakeonlan invocation.
- Acceptance: verify exact argv through a spawn spy; test exit zero, nonzero,
  spawn rejection, timeout/termination, and output larger than capture budget
  without hanging or unbounded buffering. Test subprocess fixtures exercise real
  pipe draining and exit/kill handling; mock-only tests are insufficient here.
  Inject short test deadlines to avoid five-second waits without changing
  production timeout. Runner returns only the three C3 result kinds and cleans up.
- Verification: `bun test tests/server/runner.test.ts`, `bun run test:server`,
  `bun run check`, `bun run format:check`.
- Stop: unverified Bun spawn behavior prevents safe termination/draining. Report
  exact observed API behavior; do not replace CLI invocation with custom UDP.

## P06 — Wake endpoint and per-device state machine

- Goal: connect runner/repository through the concurrency-safe C3 wake service.
- Scope: src/server/wake.ts, app.ts, index.ts, tests/server/wake.test.ts and wake
  HTTP tests; test-server fixture injection. No UI forms yet.
- Acceptance: known ID uses effective broadcast; unknown ID never spawns; status
  mappings and timestamps follow C2/C3. Use deferred promises and fake clocks to
  prove two simultaneous requests start one command, failure still cools down,
  another device can proceed, and completion releases busy state on all paths.
  Check PATCH/DELETE conflict during in-flight execution, permitted update after
  completion, cooldown expiry, retry headers, startup reset of cooldown, and
  database failure after CLI success without command retry.
- Verification: `bun test tests/server/wake.test.ts`, `bun run test:server`,
  `bun run check`, `bun run build`, `bun run test:e2e`, `bun run format:check`.
- Stop: any required architecture change would introduce multiple server workers
  or distributed cooldown semantics. This MVP intentionally runs one process.

## P07 — Complete mobile management and wake UI

- Goal: implement C4 against the accepted real API with fake process runner only
  in tests. Integrate full UI behavior rather than static demo data.
- Scope: src/web/, tests/e2e/, test-server fixture configuration only. No changes
  to API contracts, production runner, or security rules.
- Acceptance: browser tests at 390px exercise add/list/edit, duplicate validation,
  clearing broadcast override, cancel/confirm deletion, wake pending/success,
  failure/timeout, cooldown, list retry, and persistence after reload. Query the
  API to verify resulting records, not only toast text. Test keyboard operation,
  named controls/live feedback, escaped names, and no horizontal overflow.
  UI does not claim online/boot status and cannot bypass server-side cooldown.
- Verification: `bun run check`, `bun run test:server`, `bun run build`,
  `bun run test:e2e`, `bun run format:check`.
- Stop: new product behavior or API response shape is needed. Do not hardcode
  success feedback or add production test-mode controls to satisfy tests.

## P08 — Production operation and final automated acceptance

- Goal: finish production composition and accurate operating documentation;
  validate the integrated build without network/hardware side effects.
- Scope: src/server/index.ts/config.ts production wiring; tests/server startup
  and static tests; tests/e2e integration; README.md; .env.example; example service
  at docs/wol-poc.service. Runtime docs must not embed real machine addresses or
  pretend unknown operator values have been supplied.
- Acceptance: production wires persistent repository and actual runner, resolves
  executable availability without running a wake command, handles graceful close,
  and fails safely for bad config, missing build, or missing executable. Verify
  static assets cannot expose SQLite or traverse outside dist, origin handling
  works with configured HTTPS public origin and loopback backend, and database
  survives close/reopen. Document scripts, environment, proxy expectations,
  unprivileged service operation/PATH, persistent backup location, and diagnostics.
  Service example uses explicit WorkingDirectory and persistent DB path; do not
  install/enable it or change Tailscale. Read installed CLI help/docs or inspect
  its argument parser to establish -i support if available; do not send a packet.
  If the deployment host is unavailable, record this check pending for P09.
- Verification: `bun run check`, `bun run test:server`, `bun run build`,
  `bun run test:e2e`, `bun run format:check`. Test production startup/shutdown via
  controlled fixtures; never run bun run start against implicit live settings.
- Stop: required OS/service configuration change or missing target-host evidence.
  Preserve a clear list of operator prerequisites rather than making changes.

## P09 — Authorized deployment smoke test

- Goal: verify the actual phone/proxy/server path. This is not another firmware
  investigation; WoL and Tailscale are already proven separately.
- Scope: operator-led manual verification and recording evidence in status only.
  No infrastructure modification or wake command until explicitly authorized.
- Prerequisites: approved listen port, actual HTTPS APP_ORIGIN, known working
  broadcast, persistent DB location, service user/PATH, and a designated target
  MAC. Operator confirms permission to start the service and wake that target.
- Procedure: confirm installed wakeonlan accepts -i without sending a packet;
  start/operate the app through approved existing infrastructure; open it from
  phone; register target; reload and restart to confirm persistence; trigger one
  Wake; record response and last-sent time; separately record observed boot
  outcome. Check intended private access and cross-origin mutation rejection.
- Acceptance: phone can perform CRUD and request wake, CLI result is reflected
  truthfully, state survives restart, and no public exposure was introduced.
  A target that does not boot must be disclosed, not masked by HTTP success.
- Verification: manual observations with safe timestamps/statuses; do not store
  private access credentials or full machine network inventory in the handoff.
- Stop: missing authorization/configuration, CLI mismatch, unexpected exposure,
  or failed end-to-end behavior. Mark blocked/failed rather than claiming complete.

## 6. Requirement coverage and final gate

| Requirement | Owner packets | Acceptance evidence |
| --- | --- | --- |
| R1 | P01, P02, P08 | Built frontend served through Bun; startup/static tests |
| R2 | P03, P04, P07 | Repository/HTTP CRUD and browser management flows |
| R3 | P03, P06, P08 | Real temporary SQLite reopen and sent timestamp tests |
| R4 | P05, P06 | Exact argv spy, process fixtures, injected endpoint tests |
| R5 | P02, P07 | Mobile browser states, forms, keyboard and feedback checks |
| R6 | P03, P04, P06 | Validation rejection and deterministic concurrent-request tests |
| R7 | P05, P06, P07 | Timeout/kill/error fixtures, retained timestamps, UI errors |
| R8 | P02, P04, P08, P09 | Origin/body/static safeguards and actual private proxy check |
| R9 | P01–P08 | Full type/build/server/browser/format gates, zero real wake calls |
| R10 | P08, P09 | Accurate runtime docs plus authorized phone/proxy observation |

Final automated gates must all run after the last code correction. Code complete
with P09 pending must be reported as "automated acceptance complete; live
deployment/phone verification pending", not full product acceptance. Record any
environment-blocked test or explicit waiver with affected requirements.

## 7. Readiness, risks, and resume information

The MVP and access model are confirmed. Technical contracts in this revision need
user approval before workers begin. P01 is first eligible after that approval.
Runtime/tool versions and proposed commands remain unverified until bootstrap.
No product work is silently deferred beyond the explicitly agreed non-goals.

Most likely worker errors and countermeasures:

1. Treating CLI success as proof of boot: fixed response/UI text and separate
   manual boot observation in C2/C4/P09.
2. Sending real packets from tests or injecting shell text: fixed argv and a
   private process seam in C3/P05; test-only runner wiring never exposed in production.
3. Allowing races or edits during wake: reserve before await, finally cleanup,
   completion-based cooldown, busy edit/delete conflicts, and deferred-promise
   concurrency tests in C3/P06.

Deployment blockers apply to P09 only: actual origin, port, broadcast, DB location,
target device, service environment, and explicit live-test authorization. These
values are configuration, not reasons to hardcode assumptions or alter Tailscale.

If discovery, app accounts, direct Tailscale binding, or multi-process deployment
is requested later, revise the relevant product/security contracts before work.

## 8. CLI-default simplification — `wol-cli-default-r2`

### Source, approval and baseline

- Source: user observed the configured documentation broadcast did not wake the
  target although the CLI exited 0; invoking `wakeonlan <MAC>` manually did work.
- Authorization: user explicitly requested updating impl and using Strata to make
  the changes. This authorizes r2 code/docs/tests, not live wake/deployment actions.
- Existing implementation: r1 P01–P08 accepted; production config requires
  WOL_BROADCAST_ADDRESS, wake service supplies it as a fallback, runner always
  inserts `-i`, and UI labels null overrides as `Server default`.
- Preserve docs/plan.md as historical source, existing user edits, SQLite records,
  shared HTTP device shapes, origin security, and loopback-only binding. No
  dependencies, commits, infrastructure changes, or automated hardware calls.

### Revised contracts (R4, R5, R9, R10)

- Remove the global broadcast setting from AppConfig and WakeServiceOptions.
  WOL_BROADCAST_ADDRESS is no longer read or required, including if an old .env
  still contains it. Do not read, edit, or delete the user's real .env.
- Keep Device.broadcastAddress and create/update shapes/validation unchanged.
  null means delegate to the installed CLI's default; an explicit valid per-device
  override still wins. Do not silently clear existing overrides or migrate data.
- RunWakeCommand takes `{ macAddress: string; broadcastAddress: string | null }`.
  For null the exact argv is `["wakeonlan", macAddress]`; for a saved override it
  remains `["wakeonlan", "-i", broadcastAddress, macAddress]`. Never invoke a shell,
  infer a subnet, or hardcode an IP for the default path. Preserve 5s timeout,
  bounded concurrent output draining, errors, timestamps and cooldown behavior.
- Keep APP_ORIGIN required and its exact-origin mutation checks; keep HOST
  loopback-only. Broadcast destination is not the loopback bind address.
- UI says `CLI default` for no override and explains blank delegates to wakeonlan.
  Add/edit override stays optional. No unsupported reachability/boot claims.
- Docs lead with plain `wakeonlan <MAC>` behavior, omit global broadcast setup,
  explain removing obsolete WOL_BROADCAST_ADDRESS has no effect on stored device
  overrides, and advise clearing a wrong override through the edit form.
  .env.example must not contain a broadcast example that can become live config.
- User-reported manual behavior is evidence only for that manual command, not a
  newly verified app/phone smoke test. P09 live verification stays separately gated;
  `-i` compatibility is needed only if an optional override will be used.

### P10a — Backend CLI default (R4, R9)

- Bootstrap reads: this amendment; src/shared/contracts.ts runner types;
  src/server/config.ts, wake.ts, runner.ts, index.ts; corresponding server tests
  and tests/e2e/harness.ts configuration consumers.
- Scope: shared runner type, backend config/wake/runner/index, tests/server,
  tests/e2e/harness.ts only for config/service compatibility, harmless fixtures
  if needed. Worker handoff: docs/work/P10-handoff.md. No web UI/docs/dependencies.
- Acceptance: startup without broadcast variable succeeds; old environment value
  cannot affect commands; null override emits exact MAC-only argv; explicit device
  override emits exact -i argv; clearing override restores CLI default. Meaningful
  config/service/argv tests preserve process, security, timestamp and cooldown tests.
- Focused checks: config/runner/wake/startup tests and `bun run check`;
  acceptance: `bun run test:server`. Document temporary expected browser wording
  mismatches for P10b; do not weaken old assertions.

### P10b — UI/docs and final integration (R5, R9, R10)

- Depends on accepted P10a. Bootstrap: amendment, P10 handoff, src/web/App.svelte,
  README.md, .env.example, docs/wol-poc.service, tests/e2e broadcast assertions.
- Scope: src/web/App.svelte labels/help only, README.md, .env.example,
  docs/wol-poc.service if needed, tests/e2e; worker handoff docs/work/P10-handoff.md.
- Acceptance: UI accurately names CLI default; existing management flows still
  work, blank override and explicit override round-trip correctly, docs show
  safe minimal config, no global broadcast required, no real runtime env/data edits.
- Final gates after last changes, repository root: `bun run check`,
  `bun run test:server`, `bun run build`, `bun run test:e2e`,
  `bun run format:check`. Use installed Bun path if not on shell PATH; no installs.
- All subprocess tests use harmless seams/fixtures, never installed wakeonlan.
  Report files, exact command exits, unmet criteria and live checks not run.

### Stop conditions

Stop for unexpected user edits/conflicts, dependency changes, required data
migration, or changes to origin/security semantics. Keep implementation in source
on incomplete turns and update handoff; do not leave diagnostic stubs or rely on
temporary backups. Parent owns status and acceptance.
