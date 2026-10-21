# AGENTS.md

Working agreement and verified guide for `wol-poc`. The approved contract is `IMPLEMENTATION.md`;
actual evidence and pending checks live in `IMPLEMENTATION_STATUS.md`.

## Working rules

1. **No delegation.** Single agent, single implementation attempt. P01–P05 are sequential phases for
   the same agent, not worker assignments.
2. **Never touch the operator's real `.env`.** It is local state and git-ignored; only
   `.env.example` is edited. Tests run with a minimal environment so a real `.env` cannot leak into a
   child process.
3. **Tests must be incapable of waking real equipment.** No real `wakeonlan` invocation, no real MAC,
   no live Tailscale mutation. Inject a harmless runner; the E2E fixture records calls instead of
   spawning anything.
4. **Record, do not assert.** Gates that cannot run on the current host (Docker daemon, hardware,
   phone, Tailscale) are recorded as pending with the exact error. Never report a hardware check as
   passed without observing it.

## Architecture

```text
src/shared/contracts.ts   Device/input/error types, MAC normalisation, validation (single source of truth)
src/server/config.ts      Env parsing and origin validation; fixed loopback bind
src/server/store.ts       bun:sqlite, one devices table, parameterized CRUD, unique-constraint -> conflict
src/server/wake.ts        Bounded subprocess adapter, argv always [executable, mac]
src/server/app.ts         Request handler assembled from injected deps; static allowlist
src/server/index.ts       Real wiring: Bun.serve, startup failure paths, SIGINT/SIGTERM shutdown
src/client/               React dashboard, api helper, hand-written shadcn-style primitives
scripts/dev.ts            Loopback Bun API + fixed-port Vite, cleaned up together
```

Importing any module must not start a listener or emit a packet. Only the entrypoint binds a socket,
and only the adapter creates a process.

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck     # tsconfig.client.json + tsconfig.server.json + tsconfig.test.json
bun run test          # bun test tests/unit tests/integration
bun run build         # vite build -> dist/
bun run format:check  # prettier
bun run test:e2e      # playwright, fixture server on 127.0.0.1:7323
```

## Invariants

- Bind address is always `127.0.0.1`. There is no `HOST` variable.
- Every mutation requires `Origin` equal to `APP_ORIGIN` exactly; no CORS middleware exists.
- Wake success means "Wake request sent". Nothing may claim a device is online, and there is no
  online detection or fabricated last-wake state.
- Wake is one bound subprocess (5s), no retry, per-device in-flight set cleared in `finally`.
- The adapter owns the output policy (`stdout: ignore`, `stderr: pipe` with a bounded drain); raw
  subprocess diagnostics never reach an HTTP response.
- Static serving is an explicit allowlist of built files; hidden files, sourcemaps, `.env`, the
  database, and arbitrary request paths are never served.
- Store failures fail startup; there is no in-memory fallback.

## Test entrypoints

- `tests/unit/` — contracts, config, store, and the real subprocess adapter through an injected
  harmless executable.
- `tests/integration/` — handler-level `Request` tests against a real temp SQLite file, a real
  loopback `Bun.serve` smoke test, and child-process startup/shutdown tests with a minimal env.
- `tests/fixtures/e2e-server.ts` — real handler and real SQLite with a recorder wake runner, plus
  test-only control routes (`/__test/behaviour`, `/__test/wakes`, `/__test/reset`). Test-only code is
  not copied into the runtime image.
- `tests/e2e/` — desktop and 360px mobile journeys, including keyboard focus return and reduced
  motion.

## Deployment pitfalls

- Install `wakeonlan` **inside the image**; the host binary is not inherited by a container.
- Keep `network_mode: host`. Bridge networking or a `0.0.0.0` bind breaks broadcast delivery.
- Run the final container as a non-root user and make the named volume writable by ownership, not by
  privileged mode or `chmod`.
- `docker compose down -v` destroys the persistent volume.
- Tailscale runs on the host. Do not enable Funnel or replace an existing Serve configuration, and do
  not claim Tailscale can send a magic packet.
