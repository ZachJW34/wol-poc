import type { InputHTMLAttributes } from "react";

import { cn } from "@/client/lib/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-[44px] w-full rounded-field border border-line bg-panel-2 px-3 text-ink " +
          "placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-accent",
        className,
      )}
      {...props}
    />
  );
}
