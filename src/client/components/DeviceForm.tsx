import { useEffect, useState, type FormEvent } from "react";

import { validateDeviceInput } from "@/shared/contracts";
import type { Device, DeviceInput, FieldName } from "@/shared/contracts";
import { Button } from "@/client/components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogRoot,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";

export type FieldErrors = Partial<Record<FieldName, string>>;

export function DeviceForm({
  open,
  device,
  restoreFocusTo,
  onClose,
  onSubmit,
}: {
  open: boolean;
  /** null while adding; the device being edited otherwise. */
  device: Device | null;
  restoreFocusTo: HTMLElement | null;
  onClose: () => void;
  /** Returns field errors, or null when the server confirmed the save. */
  onSubmit: (input: DeviceInput) => Promise<FieldErrors | null>;
}) {
  const [name, setName] = useState("");
  const [mac, setMac] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  // Values are preserved on failure; they are only reset when the dialog is reopened.
  useEffect(() => {
    if (open) {
      setName(device?.name ?? "");
      setMac(device?.mac ?? "");
      setErrors({});
      setSaving(false);
    }
  }, [open, device]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const result = validateDeviceInput({ name, mac });
    if (!result.ok) {
      setErrors(result.fields);
      return;
    }

    setSaving(true);
    const serverErrors = await onSubmit(result.input);
    setSaving(false);
    if (serverErrors) setErrors(serverErrors);
  }

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogOverlay />
      <DialogContent restoreFocusTo={restoreFocusTo}>
        <DialogTitle>{device ? "Edit device" : "Add device"}</DialogTitle>
        <DialogDescription>
          Saved on this server. A saved device is not a claim that it is online.
        </DialogDescription>

        <form onSubmit={handleSubmit} className="mt-4 grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="device-name">Name</Label>
            <Input
              id="device-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? "device-name-error" : undefined}
            />
            {errors.name ? (
              <p id="device-name-error" className="text-sm text-danger">
                {errors.name}
              </p>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="device-mac">MAC address</Label>
            <Input
              id="device-mac"
              value={mac}
              onChange={(event) => setMac(event.target.value)}
              aria-describedby="device-mac-hint"
              aria-invalid={errors.mac ? true : undefined}
            />
            <p id="device-mac-hint" className="text-sm text-ink-muted">
              Six hex byte pairs, for example <span className="font-mono">c8:53:09:f8:8a:32</span>{" "}
              or <span className="font-mono">c8-53-09-f8-8a-32</span>.
            </p>
            {errors.mac ? (
              <p id="device-mac-error" className="text-sm text-danger">
                {errors.mac}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
