import type { Device } from "@/shared/contracts";
import { Button } from "@/client/components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogRoot,
  DialogTitle,
} from "@/client/components/ui/dialog";

export function DeleteDialog({
  open,
  device,
  busy,
  restoreFocusTo,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  device: Device | null;
  busy: boolean;
  restoreFocusTo: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogOverlay />
      <DialogContent
        role="alertdialog"
        aria-describedby="delete-description"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogTitle>Delete device</DialogTitle>
        <DialogDescription id="delete-description">
          Delete <strong>{device?.name}</strong> ({device?.mac})? The card is removed only after the
          server confirms.
        </DialogDescription>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
