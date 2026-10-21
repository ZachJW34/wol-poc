import * as RadixDialog from "@radix-ui/react-dialog";

import { cn } from "@/client/lib/cn";

export function DialogRoot(props: RadixDialog.DialogProps) {
  return <RadixDialog.Root {...props} />;
}

export function DialogTrigger(props: RadixDialog.DialogTriggerProps) {
  return <RadixDialog.Trigger {...props} />;
}

export function DialogOverlay() {
  return <RadixDialog.Overlay className="fixed inset-0 bg-black/60" />;
}

export type DialogContentProps = RadixDialog.DialogContentProps & {
  /** Element that opened the dialog; focus returns here when it closes. */
  restoreFocusTo?: HTMLElement | null;
};

export function DialogContent({ className, restoreFocusTo, ...props }: DialogContentProps) {
  return (
    <RadixDialog.Content
      {...props}
      className={cn(
        "fixed inset-0 m-auto w-[min(100%, 460px)] rounded-card border border-line bg-panel p-5 shadow-2xl",
        className,
      )}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        restoreFocusTo?.focus();
      }}
    />
  );
}

export function DialogTitle({ className, ...props }: RadixDialog.DialogTitleProps) {
  return <RadixDialog.Title className={cn("text-lg font-semibold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: RadixDialog.DialogDescriptionProps) {
  return <RadixDialog.Description className={cn("mt-1 text-ink-muted", className)} {...props} />;
}

export function DialogClose({ className, ...props }: RadixDialog.DialogCloseProps) {
  return (
    <RadixDialog.Close
      {...props}
      className={cn(
        "mt-4 min-h-[44px] rounded-field border border-line bg-panel-2 px-4 text-ink",
        className,
      )}
    />
  );
}
