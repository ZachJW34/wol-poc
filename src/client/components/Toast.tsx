import { cn } from "@/client/lib/cn";

export type ToastMessage = {
  id: number;
  tone: "success" | "error";
  message: string;
  /** Re-runs the action that failed; failures must not be silently swallowed. */
  retry?: () => void;
};

export function ToastRegion({
  toast,
  onDismiss,
}: {
  toast: ToastMessage | null;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 p-4" aria-label="Notifications">
      {toast ? (
        <div
          data-testid="toast"
          role={toast.tone === "error" ? "alert" : "status"}
          aria-live={toast.tone === "error" ? "assertive" : "polite"}
          className={cn(
            "mx-auto flex max-w-[560px] flex-wrap items-center gap-3 rounded-card border bg-panel px-4 py-3",
            toast.tone === "error" ? "border-danger/60" : "border-accent/60",
          )}
        >
          <span className="flex-1">{toast.message}</span>
          {toast.retry ? (
            <button
              type="button"
              onClick={toast.retry}
              className="min-h-[44px] rounded-field border border-line bg-panel-2 px-3"
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notification"
            className="min-h-[44px] rounded-field px-3 text-ink-muted"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
