import type { HTMLAttributes } from "react";

import { cn } from "@/client/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-card border border-line bg-panel", className)} {...props} />;
}
