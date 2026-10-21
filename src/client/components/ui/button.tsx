import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/client/lib/cn";

export type ButtonVariant = "primary" | "outline" | "ghost" | "danger";
export type ButtonSize = "default" | "icon";

const base =
  "inline-flex items-center justify-center gap-2 rounded-field border font-medium " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const variants: Record<ButtonVariant, string> = {
  primary: "border-accent bg-accent text-accent-ink hover:bg-accent/85",
  outline: "border-line bg-panel-2 text-ink hover:border-ink-muted",
  ghost: "border-transparent bg-transparent text-ink-muted hover:bg-panel-2 hover:text-ink",
  danger: "border-danger/60 bg-danger/15 text-danger hover:bg-danger/25",
};

const sizes: Record<ButtonSize, string> = {
  default: "min-h-[44px] px-4 py-2",
  icon: "size-11",
};

export function Button({
  className,
  variant = "primary",
  size = "default",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type={type}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  );
}
