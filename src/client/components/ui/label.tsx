import type { LabelHTMLAttributes } from "react";

import { cn } from "@/client/lib/cn";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block font-medium text-ink", className)} {...props} />;
}
