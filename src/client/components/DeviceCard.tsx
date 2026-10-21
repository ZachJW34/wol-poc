import type { MouseEvent } from "react";
import { Pencil, Power, Trash2 } from "lucide-react";

import type { Device } from "@/shared/contracts";
import { Button } from "@/client/components/ui/button";
import { Card } from "@/client/components/ui/card";

export function DeviceCard({
  device,
  isWaking,
  onWake,
  onEdit,
  onDelete,
}: {
  device: Device;
  isWaking: boolean;
  onWake: () => void;
  /** The clicked button is remembered so dialog close can return focus to it. */
  onEdit: (source: HTMLElement) => void;
  onDelete: (source: HTMLElement) => void;
}) {
  return (
    <Card data-testid={`device-${device.id}`} className="p-4">
      <h2 className="text-base font-semibold">{device.name}</h2>
      <p className="mt-1 font-mono text-sm text-ink-muted">{device.mac}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={onWake} disabled={isWaking} aria-busy={isWaking}>
          <Power aria-hidden="true" />
          {isWaking ? "Sending…" : "Wake"}
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={(event) => onEdit(event.currentTarget)}
          disabled={isWaking}
          aria-label={`Edit ${device.name}`}
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={(event) => onDelete(event.currentTarget)}
          disabled={isWaking}
          aria-label={`Delete ${device.name}`}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}
