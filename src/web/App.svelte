<script lang="ts">
  import { ApplicationError, type Device } from "../shared/contracts";
  import {
    createDevice,
    deleteDevice,
    fetchDevices,
    updateDevice,
    wakeDevice,
  } from "./api";
  import { validateForm, type FieldErrors } from "./validation";

  type State =
    | { status: "loading" }
    | { status: "ready"; devices: Device[] }
    | { status: "error"; message: string };

  type Announcement = { label: string; device?: string };

  type FormFields = {
    name: string;
    macAddress: string;
    broadcastAddress: string;
  };

  // `view` (not `state`) keeps svelte-check from reading `$state` as a legacy
  // auto-subscribe of a store named `state`; the type goes on the variable.
  let view: State = $state({ status: "loading" });
  let announcement: Announcement | null = $state(null);

  /** Devices this browser is currently waking; nothing else may change them. */
  let pendingWakes: Set<string> = $state(new Set<string>());
  /** Per-device 429 windows taken from the server's `retryAfterMs`. */
  let cooldownUntil: Map<string, number> = $state(new Map<string, number>());

  /**
   * Svelte 5 proxies plain objects and arrays, not `Map`/`Set`, so a mutation
   * alone would never be observed by the UI. Every change reassigns a new
   * collection, which is what makes the pending and cooldown states reactive.
   */
  function markPending(id: string, pending: boolean): void {
    const next = new Set(pendingWakes);
    if (pending) {
      next.add(id);
    } else {
      next.delete(id);
    }
    pendingWakes = next;
  }

  function markCooldown(id: string, retryAfterMs: number): void {
    cooldownUntil = new Map(cooldownUntil).set(id, Date.now() + retryAfterMs);
    setTimeout(() => {
      const next = new Map(cooldownUntil);
      next.delete(id);
      cooldownUntil = next;
    }, retryAfterMs);
  }

  let addFields: FormFields = $state({
    name: "",
    macAddress: "",
    broadcastAddress: "",
  });
  let addErrors: FieldErrors = $state({});

  let editingId: string = $state("");
  let editFields: FormFields = $state({
    name: "",
    macAddress: "",
    broadcastAddress: "",
  });
  let editErrors: FieldErrors = $state({});

  let confirmingId: string = $state("");

  async function load(): Promise<void> {
    view = { status: "loading" };
    try {
      view = { status: "ready", devices: await fetchDevices() };
    } catch (error) {
      view = { status: "error", message: message(error) };
    }
  }

  /** Re-read the authoritative list after a mutation, keeping any announcement. */
  async function refresh(): Promise<void> {
    try {
      view = { status: "ready", devices: await fetchDevices() };
    } catch (error) {
      view = { status: "error", message: message(error) };
    }
  }

  function announce(label: string, device?: string): void {
    announcement = { label, device };
  }

  function message(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }

  function hasErrors(errors: FieldErrors): boolean {
    return Object.keys(errors).length > 0;
  }

  function isPending(id: string): boolean {
    return pendingWakes.has(id);
  }

  function isCoolingDown(id: string): boolean {
    return cooldownUntil.has(id);
  }

  function cooldownSeconds(id: string): number {
    const deadline = cooldownUntil.get(id) ?? 0;
    return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  }

  function sentText(value: string | null): string {
    if (value === null) {
      return "Never sent";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  async function submitAdd(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const validated = validateForm(addFields);
    addErrors = validated.errors;
    if (hasErrors(validated.errors)) {
      announce("The device was not added: fix the highlighted fields.");
      return;
    }
    try {
      const device = await createDevice(validated.input);
      addFields = { name: "", macAddress: "", broadcastAddress: "" };
      addErrors = {};
      await refresh();
      announce("Device added", device.name);
    } catch (error) {
      // Inputs are retained so the user can correct a duplicate or a rejected field.
      announce(`The device was not added: ${message(error)}`);
    }
  }

  function startEdit(device: Device): void {
    if (isPending(device.id)) {
      return;
    }
    editingId = device.id;
    editFields = {
      name: device.name,
      macAddress: device.macAddress,
      broadcastAddress: device.broadcastAddress ?? "",
    };
    editErrors = {};
  }

  function cancelEdit(): void {
    editingId = "";
    editErrors = {};
  }

  async function submitEdit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const device = findDevice(editingId);
    if (device === null) {
      return;
    }
    const validated = validateForm(editFields);
    editErrors = validated.errors;
    if (hasErrors(validated.errors)) {
      announce("The device was not updated: fix the highlighted fields.");
      return;
    }
    try {
      const updated = await updateDevice(device.id, validated.input);
      editingId = "";
      editErrors = {};
      await refresh();
      announce("Device updated", updated.name);
    } catch (error) {
      // The device is preserved and the inputs stay available.
      announce(`The device was not updated: ${message(error)}`);
    }
  }

  function startDelete(device: Device): void {
    if (isPending(device.id)) {
      return;
    }
    confirmingId = device.id;
  }

  /** Cancel does nothing: no API call is made for a cancelled deletion. */
  function cancelDelete(): void {
    confirmingId = "";
  }

  async function confirmDelete(device: Device): Promise<void> {
    try {
      await deleteDevice(device.id);
      confirmingId = "";
      await refresh();
      announce("Device deleted", device.name);
    } catch (error) {
      announce(`The device was not deleted: ${message(error)}`);
    }
  }

  async function wake(device: Device): Promise<void> {
    if (isPending(device.id) || isCoolingDown(device.id)) {
      return;
    }
    markPending(device.id, true);
    try {
      const result = await wakeDevice(device.id);
      // The timestamp comes from the returned device, never from a local guess.
      replaceDevice(result.device);
      announce("Wake packet sent", device.name);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "WAKE_COOLDOWN") {
        const retryAfterMs = error.retryAfterMs ?? 0;
        markCooldown(device.id, retryAfterMs);
        announce(`Wake failed: ${error.message}`, device.name);
      } else {
        announce(`Wake failed: ${message(error)}`, device.name);
      }
    } finally {
      markPending(device.id, false);
    }
  }

  function findDevice(id: string): Device | null {
    if (view.status !== "ready") {
      return null;
    }
    return view.devices.find((device) => device.id === id) ?? null;
  }

  function replaceDevice(device: Device): void {
    if (view.status !== "ready") {
      return;
    }
    const index = view.devices.findIndex(
      (existing) => existing.id === device.id,
    );
    if (index === -1) {
      return;
    }
    const devices = [...view.devices];
    devices[index] = device;
    view = { status: "ready", devices };
  }

  $effect(() => {
    void load();
  });
</script>

<main>
  <h1>Wake-on-LAN devices</h1>

  <!-- One always-present live region: only its contents change as view changes. -->
  <div class="status" role="status" aria-live="polite">
    {#if view.status === "loading"}
      <p>Loading devices…</p>
    {:else if view.status === "error"}
      <p>Could not load devices: {view.message}</p>
      <button type="button" onclick={() => void load()}>Retry</button>
    {:else if view.devices.length === 0}
      <p>No devices yet. Add a device to get started.</p>
    {:else}
      <ul class="devices">
        {#each view.devices as device}
          <li class="device-card">
            <p class="device-name">{device.name}</p>
            <p class="meta">MAC: {device.macAddress}</p>
            <p class="meta">
              Broadcast: {device.broadcastAddress ?? "Server default"}
            </p>
            <p class="meta">
              Last sent:
              {#if device.lastWakeSentAt === null}
                Never sent
              {:else}
                <time datetime={device.lastWakeSentAt}>
                  {sentText(device.lastWakeSentAt)}
                </time>
              {/if}
            </p>

            <p class="actions">
              <button
                type="button"
                aria-label={`Wake ${device.name}`}
                disabled={isPending(device.id) || isCoolingDown(device.id)}
                onclick={() => void wake(device)}
              >
                {isPending(device.id) ? "Waking…" : "Wake"}
              </button>
              <button
                type="button"
                aria-label={`Edit ${device.name}`}
                disabled={isPending(device.id)}
                onclick={() => startEdit(device)}
              >
                Edit
              </button>
              <button
                type="button"
                aria-label={`Delete ${device.name}`}
                disabled={isPending(device.id)}
                onclick={() => startDelete(device)}
              >
                Delete
              </button>
            </p>

            {#if isCoolingDown(device.id)}
              <p class="cooldown">
                Cooldown: try again in {cooldownSeconds(device.id)} s.
              </p>
            {/if}

            {#if editingId === device.id}
              <form class="edit-form" onsubmit={submitEdit}>
                <p>
                  <label for="edit-name">Name</label>
                  <input
                    id="edit-name"
                    name="name"
                    bind:value={editFields.name}
                    aria-describedby="edit-name-error"
                    aria-invalid={editErrors.name !== undefined}
                  />
                </p>
                <p id="edit-name-error" class="field-error">
                  {editErrors.name ?? ""}
                </p>
                <p>
                  <label for="edit-mac">MAC address</label>
                  <input
                    id="edit-mac"
                    name="macAddress"
                    bind:value={editFields.macAddress}
                    aria-describedby="edit-mac-error"
                    aria-invalid={editErrors.macAddress !== undefined}
                  />
                </p>
                <p id="edit-mac-error" class="field-error">
                  {editErrors.macAddress ?? ""}
                </p>
                <p>
                  <label for="edit-broadcast">Broadcast override</label>
                  <input
                    id="edit-broadcast"
                    name="broadcastAddress"
                    bind:value={editFields.broadcastAddress}
                    aria-describedby="edit-broadcast-help edit-broadcast-error"
                    aria-invalid={editErrors.broadcastAddress !== undefined}
                  />
                </p>
                <p id="edit-broadcast-help" class="help">
                  Leave blank to use the server default.
                </p>
                <p id="edit-broadcast-error" class="field-error">
                  {editErrors.broadcastAddress ?? ""}
                </p>
                <p class="actions">
                  <button type="submit">Save changes</button>
                  <button type="button" onclick={cancelEdit}>Cancel</button>
                </p>
              </form>
            {/if}

            {#if confirmingId === device.id}
              <p class="confirm">
                Delete {device.name}?
                <button type="button" onclick={cancelDelete}>Cancel</button>
                <button
                  type="button"
                  onclick={() => void confirmDelete(device)}
                >
                  Confirm delete
                </button>
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if announcement !== null}
      <p class="feedback">
        <span class="feedback-label">{announcement.label}</span>
        {#if announcement.device !== undefined}
          <span class="feedback-device">{announcement.device}</span>
        {/if}
      </p>
    {/if}
  </div>

  <form class="add-form" onsubmit={submitAdd}>
    <h2>Add a device</h2>
    <p>
      <label for="add-name">Name</label>
      <input
        id="add-name"
        name="name"
        bind:value={addFields.name}
        aria-describedby="add-name-error"
        aria-invalid={addErrors.name !== undefined}
      />
    </p>
    <p id="add-name-error" class="field-error">{addErrors.name ?? ""}</p>
    <p>
      <label for="add-mac">MAC address</label>
      <input
        id="add-mac"
        name="macAddress"
        bind:value={addFields.macAddress}
        aria-describedby="add-mac-error"
        aria-invalid={addErrors.macAddress !== undefined}
      />
    </p>
    <p id="add-mac-error" class="field-error">{addErrors.macAddress ?? ""}</p>
    <p>
      <label for="add-broadcast">Broadcast override</label>
      <input
        id="add-broadcast"
        name="broadcastAddress"
        bind:value={addFields.broadcastAddress}
        aria-describedby="add-broadcast-help add-broadcast-error"
        aria-invalid={addErrors.broadcastAddress !== undefined}
      />
    </p>
    <p id="add-broadcast-help" class="help">
      Optional. Leave blank to use the server default.
    </p>
    <p id="add-broadcast-error" class="field-error">
      {addErrors.broadcastAddress ?? ""}
    </p>
    <p class="actions">
      <button type="submit">Add device</button>
    </p>
  </form>
</main>

<style>
  main {
    box-sizing: border-box;
    max-width: 390px;
    margin: 0 auto;
    padding: 12px;
    font-family: system-ui, sans-serif;
    line-height: 1.4;
  }

  h1 {
    font-size: 1.25rem;
  }

  h2 {
    font-size: 1.05rem;
  }

  ul.devices {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }

  .device-card,
  .add-form {
    box-sizing: border-box;
    border: 1px solid #d0d4da;
    border-radius: 8px;
    padding: 10px;
    overflow-wrap: anywhere;
  }

  .device-name {
    margin: 0 0 6px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .meta {
    margin: 2px 0;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }

  p {
    margin: 6px 0;
  }

  label {
    display: block;
    font-size: 0.9rem;
    font-weight: 600;
  }

  input {
    box-sizing: border-box;
    width: 100%;
    padding: 8px;
    font-size: 1rem;
  }

  .help,
  .field-error {
    font-size: 0.85rem;
  }

  .field-error {
    color: #a11d1d;
  }

  .help {
    color: #55606c;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  button {
    font-size: 1rem;
    padding: 8px 12px;
    border: 1px solid #b6bcc4;
    border-radius: 6px;
    background: #f4f6f8;
  }

  button:disabled {
    color: #6b7480;
    background: #e8ebef;
  }

  /* Keyboard focus stays visible; nothing here depends on hover. */
  :focus-visible {
    outline: 2px solid #1450aa;
    outline-offset: 2px;
  }

  /* Long device names in live feedback must wrap inside the 390px viewport. */
  .feedback {
    margin-top: 10px;
    padding: 8px;
    border-radius: 6px;
    background: #eef4ff;
    overflow-wrap: anywhere;
  }

  .feedback-label,
  .feedback-device {
    overflow-wrap: anywhere;
  }

  .cooldown {
    font-size: 0.85rem;
    color: #7a4a00;
  }
</style>
