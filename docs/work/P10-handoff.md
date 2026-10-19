# P10 handoff — `wol-cli-default-r2`

Parent owns global status and acceptance. All P10a and P10b changes are
uncommitted working-tree edits. P10a is accepted; P10b is complete and ready for
parent review.

## P10a — backend CLI default (accepted)

### Files changed

- `src/shared/contracts.ts` — `RunWakeCommand` input is
  `broadcastAddress: string | null` (explicit `null`, not `undefined`).
- `src/server/config.ts` — `AppConfig` no longer has `broadcastAddress`;
  `loadConfig` no longer reads or validates `WOL_BROADCAST_ADDRESS` (the
  `parseBroadcast` helper was removed, so a legacy value is inert even when the
  old parser would have rejected it). Header comment updated.
- `src/server/wake.ts` — `WakeServiceOptions` no longer has
  `defaultBroadcastAddress`; the service passes `device.broadcastAddress`
  unchanged to the runner. Stale "global fallback" comment removed.
- `src/server/runner.ts` — argv is built per call: `null` →
  `[WAKE_EXECUTABLE, macAddress]` (CLI default, no address argument); non-null →
  `[WAKE_EXECUTABLE, "-i", broadcastAddress, macAddress]`. No shell, no subnet
  inference, no hardcoded default IP.
- `src/server/index.ts` — wake service composition no longer supplies a default
  broadcast address.
- Tests: `tests/server/config.test.ts` (legacy value inert; defaults test asserts
  `"broadcastAddress" in config` is false), `tests/server/contracts.test.ts`,
  `tests/server/wake.test.ts` (null passthrough + cleared override restores CLI
  default), `tests/server/runner.test.ts` (MAC-only argv and per-call `-i` argv),
  `tests/server/http.test.ts` (new cleared-override test, type/comment updates),
  `tests/server/startup.test.ts` (new startup test: a legacy
  `WOL_BROADCAST_ADDRESS` value the old parser rejected starts fine and cannot
  reach the recorded command; override-argv case uses a second device so the
  in-memory per-device cooldown cannot mask the run), `tests/e2e/harness.ts`
  (broadcast removed from `harnessConfig`; device fixture override kept).

### Acceptance criteria

- Met: startup without the broadcast variable succeeds; a legacy environment
  value cannot affect a command; `null` override emits exact MAC-only argv;
  explicit device override emits exact `-i` argv; clearing the override restores
  the CLI default; process/security/timestamp/cooldown tests preserved.

### Commands run (repo root, `PATH="/home/zachjw34/.bun/bin:$PATH"`, no installs)

- `bun test tests/server/config.test.ts tests/server/contracts.test.ts tests/server/runner.test.ts tests/server/wake.test.ts`
  → 56 pass / 0 fail / 294 expect calls, exit 0.
- `bun test tests/server/startup.test.ts tests/server/http.test.ts`
  → 88 pass / 0 fail / 373 expect calls, exit 0.
- `bun run check` → exit 0; `bun run test:server` → exit 0 (171 tests, 944
  assertions); `bun run format:check` → exit 0 after reformatting
  `tests/server/startup.test.ts`.
- `bun run build` / `bun run test:e2e`: not run in that packet (P10b gates); run
  after P10b edits, results below.

## P10b — UI wording, docs, browser tests (complete, ready for review)

### Files changed

- `src/web/App.svelte` — device card now renders
  `Broadcast: {device.broadcastAddress ?? "CLI default"}` (was "Server default");
  add-form help is "Optional. Leave blank to use the wakeonlan CLI default.";
  edit-form help is "Leave blank to use the wakeonlan CLI default. Clearing this
  field restores that default for this device." No reachability or boot claims.
- `tests/e2e/device-management.spec.ts` — new test asserts the CLI default label
  after creating a device with no override, after adding an explicit override
  (shown as the saved value), and after clearing it through Edit, plus the two
  help texts; the existing add/duplicate/edit/clear/delete test keeps every prior
  state assertion and gains only the post-clear label assertion.
- `README.md` — leads with `wakeonlan <mac address>` (CLI default) and shows
  `-i` only for a saved per-device override; environment table no longer lists
  `WOL_BROADCAST_ADDRESS`; states the variable is not read at all, so a legacy
  value is inert and stored overrides are unaffected; minimal runnable example
  (backend `127.0.0.1:7123`, HTTPS origin `https://<hostname-placeholder>:7124`);
  `APP_ORIGIN` and loopback binding retained; exit 0 still means only that the
  command completed, not that a machine booted; troubleshooting row now names the
  CLI default or the device's saved override; Pending distinguishes the earlier
  bootstrap check (`command -v wakeonlan` → not found) from current host status
  and records the operator's manual MAC-only success as evidence for that manual
  command only, with no independently run app/phone live smoke test.
- `.env.example` — global broadcast entry removed; minimal runnable shape
  (`HOST=127.0.0.1`, `PORT=7123`, `APP_ORIGIN=https://<hostname-placeholder>:7124`,
  `DATABASE_PATH=./data/wol.sqlite`); the hostname is the only placeholder; no
  broadcast placeholder that could become live config; notes that a legacy
  `WOL_BROADCAST_ADDRESS` is not read, existing stored overrides remain effective,
  and a wrong override is cleared by blanking the field in Edit and saving.
- `docs/wol-poc.service` — unchanged: it contains no broadcast setting and already
  points at the environment file, PATH, loopback description, and placeholders.
- `docs/work/P10-handoff.md` — this file.

Not edited: backend source, `docs/plan.md`, `docs/IMPLEMENTATION.md`,
`IMPLEMENTATION_STATUS.md`, real `.env`, runtime databases, dependencies,
scripts, lockfile. No commits, no service install/start, no Tailscale change, no
`wakeonlan` executed, no magic packet sent.

### Acceptance criteria

- Met: UI names the CLI default and explains blank delegates to `wakeonlan`;
  management flows still work (blank and explicit override round-trip verified in
  the browser against the API); docs show safe minimal config with no global
  broadcast; `APP_ORIGIN` and loopback semantics preserved; no boot/reachability
  claims; browser test asserts the label after create-without-override, after
  clearing, and the explicit override before clearing.
- Not run: live app/phone/proxy smoke test and real CLI `-i` verification (P09
  stays separately gated; no operator authorization or designated target).

### Final five gates (repo root, `PATH="/home/zachjw34/.bun/bin:$PATH"`, after last edits)

- `bun run check` → exit 0, 0 errors and 0 warnings.
- `bun run test:server` → exit 0, 171 pass / 0 fail / 944 expect calls.
- `bun run build` → exit 0, Vite 8.3.4, 113 modules.
- `bun run test:e2e` → exit 0, 18 Chromium tests at 390px (17 baseline + the new
  CLI-default test), 15.8s.
- `bun run format:check` → exit 0. `README.md` needed
  `bun x prettier --write README.md` (table re-padding only); `prettier` is not on
  PATH directly.
- The five gates were re-run together after the last edit (this handoff): all exit
  0 with the same counts as above.

### Confirmed facts vs hypotheses

- Confirmed: the UI label change and help text are covered by passing browser
  tests; the backend argv contract from P10a is unchanged by P10b.
- Confirmed: no e2e assertion previously referenced the old wording, so there was
  no pre-existing wording mismatch to fix.
- Hypothesis (unverified): the operator's manual MAC-only wake works on the real
  host; that is evidence for that manual command only, not for the app path.

## Next action

Parent review of the P10b files above. Nothing further is pending in this packet;
P09 live verification remains blocked pending operator configuration and separate
authorization.
