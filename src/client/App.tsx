import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { ApiFailure, api } from "@/client/api";
import { DeviceCard } from "@/client/components/DeviceCard";
import { DeleteDialog } from "@/client/components/DeleteDialog";
import { DeviceForm, type FieldErrors } from "@/client/components/DeviceForm";
import { ToastRegion, type ToastMessage } from "@/client/components/Toast";
import { Button } from "@/client/components/ui/button";
import { Card } from "@/client/components/ui/card";
import type { Device, DeviceInput } from "@/shared/contracts";

type Phase = "loading" | "ready" | "error";

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [wakingIds, setWakingIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [formDevice, setFormDevice] = useState<Device | null>(null);
  const [confirmDevice, setConfirmDevice] = useState<Device | null>(null);

  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);
  const toastId = useRef(0);

  function notify(tone: "success" | "error", message: string, retry?: () => void): void {
    toastId.current += 1;
    setToast({ id: toastId.current, tone, message, retry });
  }

  function message(error: unknown): string {
    return error instanceof ApiFailure ? error.message : "Unexpected error.";
  }

  async function load(): Promise<void> {
    setPhase("loading");
    setLoadError(null);
    try {
      const result = await api.listDevices();
      setDevices(result.devices);
      setPhase("ready");
    } catch (error) {
      setLoadError(message(error));
      setPhase("error");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openForm(device: Device | null, source: HTMLElement | null): void {
    setReturnFocusTo(source);
    setFormDevice(device);
    setFormOpen(true);
  }

  function openConfirm(device: Device, source: HTMLElement | null): void {
    setReturnFocusTo(source);
    setConfirmDevice(device);
  }

  async function submitForm(input: DeviceInput): Promise<FieldErrors | null> {
    const target = formDevice;
    try {
      if (target) {
        const { device } = await api.updateDevice(target.id, input);
        setDevices((prev) => prev.map((saved) => (saved.id === device.id ? device : saved)));
      } else {
        const { device } = await api.createDevice(input);
        setDevices((prev) => [...prev, device]);
      }

      setFormOpen(false);
      setFormDevice(null);
      notify("success", "Device saved.");
      return null;
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : null;
      notify("error", `Save failed: ${message(error)}`, () => void submitForm(input));
      return failure?.fields ?? null;
    }
  }

  async function wake(device: Device): Promise<void> {
    if (wakingIds.has(device.id)) return;

    setWakingIds((prev) => new Set(prev).add(device.id));
    try {
      await api.wakeDevice(device.id);
      // Honest copy: the command ran, which is not a claim that the device is online.
      notify("success", `Wake request sent — ${device.name}`);
    } catch (error) {
      notify("error", `Wake failed for ${device.name}: ${message(error)}`, () => void wake(device));
    } finally {
      setWakingIds((prev) => {
        const next = new Set(prev);
        next.delete(device.id);
        return next;
      });
    }
  }

  async function confirmDelete(device: Device): Promise<void> {
    setDeleting(true);
    try {
      await api.deleteDevice(device.id);
      setDevices((prev) => prev.filter((saved) => saved.id !== device.id));
      setConfirmDevice(null);
      notify("success", `Deleted ${device.name}.`);
    } catch (error) {
      notify(
        "error",
        `Delete failed for ${device.name}: ${message(error)}`,
        () => void confirmDelete(device),
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto max-w-[900px] px-4 pt-8 pb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Wake on LAN</h1>
            <p className="mt-1 text-ink-muted">
              Private LAN device dashboard. Wake requests are sent by this server.
            </p>
          </div>
          <Button onClick={(event) => openForm(null, event.currentTarget)}>
            <Plus aria-hidden="true" />
            Add device
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-[900px] px-4 pb-24">
        <p className="mb-3 text-sm text-ink-muted">
          {devices.length} {devices.length === 1 ? "device" : "devices"}
        </p>

        {phase === "loading" ? <Card className="p-4 text-ink-muted">Loading devices…</Card> : null}

        {phase === "error" ? (
          <Card className="p-4">
            <p className="text-danger">{loadError}</p>
            <Button variant="outline" className="mt-3" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              Retry
            </Button>
          </Card>
        ) : null}

        {phase === "ready" && devices.length === 0 ? (
          <Card className="p-4">
            <p>No devices saved yet.</p>
            <Button className="mt-3" onClick={(event) => openForm(null, event.currentTarget)}>
              <Plus aria-hidden="true" />
              Add your first device
            </Button>
          </Card>
        ) : null}

        {phase === "ready" && devices.length > 0 ? (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {devices.map((device) => (
              <li key={device.id}>
                <DeviceCard
                  device={device}
                  isWaking={wakingIds.has(device.id)}
                  onWake={() => void wake(device)}
                  onEdit={(source) => openForm(device, source)}
                  onDelete={(source) => openConfirm(device, source)}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </main>

      <DeviceForm
        open={formOpen}
        device={formDevice}
        restoreFocusTo={returnFocusTo}
        onClose={() => setFormOpen(false)}
        onSubmit={submitForm}
      />

      <DeleteDialog
        open={confirmDevice !== null}
        device={confirmDevice}
        busy={deleting}
        restoreFocusTo={returnFocusTo}
        onCancel={() => setConfirmDevice(null)}
        onConfirm={() => confirmDevice && void confirmDelete(confirmDevice)}
      />

      <ToastRegion toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
