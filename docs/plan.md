# Simple Wake-on-LAN web app

Status: discussion plan; not yet an implementation specification.

## Goal

From a phone, open a Tailscale-accessible web app, view registered devices, and
tap Wake to ask the server to send that device a Wake-on-LAN packet.

Keep the application small: one Bun process serves a Svelte frontend and an HTTP
API, persists device registrations, and invokes the installed `wakeonlan` CLI.

## Confirmed requirements and assumptions

- The backend must use Bun and the web app must use Svelte.
- The server already has Tailscale configured appropriately.
- Wake-on-LAN has already been proven to work from the server.
- The `wakeonlan` executable is already installed; use it instead of implementing
  UDP packet generation.
- The server has the necessary network access to wake the target devices.
- The phone communicates with the server over HTTP(S); only the server invokes
  the wake command.
- Devices must be registerable and visible in the web app.

Do not spend implementation effort reconfiguring Tailscale, installing the WoL
CLI, or proving hardware support from scratch.

## Proposed MVP scope

### Device management

- List registered devices in a mobile-friendly interface.
- Add a device with a name and MAC address.
- Edit and delete device registrations; confirm deletion in the UI.
- Allow an optional per-device IPv4 broadcast address. Otherwise, use the
  server's configured default broadcast address.
- Persist registrations across application restarts.
- Show a helpful empty state when no devices have been registered.

### Wake action

- Give each device an explicit Wake button.
- The button sends a POST request identifying the registered device.
- The backend retrieves the saved addresses and invokes `wakeonlan`.
- Show pending, success, and failure feedback, and prevent duplicate clicks while
  a request is pending.
- Apply a short server-side, per-device cooldown to prevent accidental bursts.
- Report success as **"Wake packet sent"**, not **"Device is awake"**. A successful
  CLI exit does not establish that the device received the packet or booted.
- Show the last successful wake-command time, if one exists. Label it as a sent
  time rather than a confirmed device wake time.

### Discovery decision

Manual registration is the recommended v1 approach. Automatic discovery remains
an optional follow-up, not a prerequisite for the MVP.

Discovery may suggest devices from LAN scans or neighbor information, but powered
off devices may be absent, names may be missing, and discovery does not prove WoL
support. Any later discovery feature must preserve manual registration and ask
the user to confirm suggestions before saving them.

## Proposed architecture

```text
Phone browser
    |
    | HTTP(S) through the existing Tailscale access path
    v
Bun server
    |-- Static Svelte frontend
    |-- Device management and wake API
    |-- SQLite database
    `-- wakeonlan executable --> target device's local network
```

### Stack

- Backend: Bun with `Bun.serve`.
- Frontend: Svelte with Vite; build static assets served by Bun.
- Persistence: SQLite through `bun:sqlite`.
- Runtime: one Bun process; systemd is the recommended process manager if the
  target server uses it.
- Frontend and API share one origin; no separate frontend service or cross-origin
  API access is needed.

No SvelteKit server, custom UDP sender, message queue, or separate database server
is needed for this scope.

### Device record

Proposed fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable, server-generated device identifier |
| `name` | Human-readable label |
| `macAddress` | Validated, normalized MAC address |
| `broadcastAddress` | Optional IPv4 override; otherwise use the server default |
| `lastWakeSentAt` | Nullable timestamp of the last successful CLI invocation |

Use parameterized database statements. Keep the database in a configurable,
persistent data location outside generated frontend assets.

### HTTP API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/devices` | List registered devices |
| POST | `/api/devices` | Register a device |
| PATCH | `/api/devices/:id` | Update a registration |
| DELETE | `/api/devices/:id` | Delete a registration |
| POST | `/api/devices/:id/wake` | Send a wake packet for that registered device |

Define exact payloads and response/error contracts in the implementation handoff.
Distinguish validation failures, missing devices, cooldown responses, and command
failures. Use consistent structured error responses that the UI can display.

### CLI integration

Invoke the executable directly with separate arguments, never by interpolating
user input into a shell command. Conceptually:

```ts
Bun.spawn(["wakeonlan", "-i", broadcastAddress, macAddress]);
```

This snippet illustrates argument separation only, not a complete implementation.
The implementation must also:

- Validate and normalize MAC addresses and validate IPv4 broadcast addresses.
- Validate the configured default and verify the installed executable's supported
  flags before relying on them.
- Permit wake requests only for registered devices; do not accept arbitrary CLI
  flags, executable paths, or shell fragments through the API.
- Capture exit status and bounded diagnostic output.
- Enforce a short timeout and terminate a timed-out process.
- Return sanitized errors without exposing internal paths or raw command output.
- Update `lastWakeSentAt` only after successful command completion.
- Handle simultaneous requests without bypassing the per-device cooldown.

## Access and safety

- Use the existing Tailscale access path. Do not expose the service publicly or
  enable Tailscale Funnel as part of this project.
- Bind the application according to the existing access setup; loopback is
  preferred when an existing local proxy forwards to it. Do not assume that
  loopback binding works for direct access to the server's Tailscale address.
- Treat anyone permitted to access the app as an authorized device manager in
  the proposed MVP. Confirm that this matches the actual tailnet access policy.
- Check request origins on mutation endpoints to mitigate cross-site requests;
  do not enable permissive CORS. Document the expected browser origin.
- Bound request sizes, validate fields, and avoid leaking internal diagnostics.
- Do not add user accounts, credentials, or an internet-facing authentication
  system unless the access requirements change.

## Delivery sequence

1. **Application baseline and persistence**
   - Establish the Bun/Svelte build and test setup.
   - Add device storage and CRUD API with validation and automated tests.
2. **Wake integration**
   - Add a testable command-runner boundary, timeout handling, cooldown behavior,
     and wake endpoint.
   - Use a fake command runner in tests; automated tests must not wake real devices.
3. **Mobile web interface**
   - Add the device list, add/edit/delete forms, Wake button, and feedback states.
   - Integrate the frontend with the API and cover the main interactions.
4. **Runtime and final verification**
   - Serve the production frontend build from Bun.
   - Document runtime configuration, persistent data, startup, and service operation.
   - Perform an explicitly authorized phone-to-server wake smoke test using the
     already working Tailscale and WoL setup.

This sequence is a roadmap, not the final worker packet breakdown. Introduce an
early end-to-end slice during implementation planning rather than postponing all
frontend/backend integration to the end.

## Acceptance criteria

- A phone can load the app through the existing Tailscale access path.
- A user can add, view, edit, and delete registrations.
- Registrations and successful wake-command timestamps survive a server restart.
- Waking a registered device invokes the CLI with that device's validated MAC
  address and the effective broadcast address as separate arguments.
- The UI clearly distinguishes pending requests, packets sent, and failures.
- Invalid input and unknown device IDs do not execute a wake command.
- Repeated or concurrent requests respect the per-device cooldown.
- Command failures and timeouts produce useful UI feedback without hanging the
  server or exposing raw internal diagnostics.
- Automated tests cover storage, validation, command arguments, failure/timeout
  handling, cooldown behavior, and important UI flows without sending real packets.
- A final authorized manual test exercises the phone-to-server path; observed
  target boot behavior is recorded separately from successful CLI execution.

## Out of scope for v1

- Automatic network discovery.
- Online/offline monitoring or confirmation that a device has booted.
- Scheduling, batch wake operations, shutdown, and remote power management.
- Custom UDP packet handling.
- Multiple independent network agents or remote-LAN relay infrastructure.
- Public internet exposure and multi-user account management.

## Details to settle before implementation

These do not invalidate the direction above, but need concrete values/contracts
in the implementation handoff:

- The server's working broadcast address and any need for per-device overrides.
- The current Tailscale access method, intended browser origin, listen address,
  and port. Existing infrastructure should be reused, not reconfigured blindly.
- Whether all users allowed by the existing Tailscale policy may manage devices.
- Confirmation of manual registration for v1.
- CLI timeout and cooldown duration; proposed starting values are 5 seconds each.
- Name length limits and whether duplicate MAC registrations should be rejected.
- Runtime database location and whether systemd matches the target environment.

## Next step

Review the proposed MVP decisions. Then use the `implementation-planning` skill
with this document to create `IMPLEMENTATION.md`, containing explicit contracts,
dependency-ordered worker packets, and project-grounded verification commands.
Approve that handoff separately before starting `strata-orchestration`.
