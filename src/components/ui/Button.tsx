import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "outline" | "danger" | "success";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-white hover:brightness-105 border-transparent font-semibold",
  ghost: "bg-transparent text-muted hover:bg-surface-3 hover:text-fg border-transparent",
  outline: "bg-surface text-fg hover:bg-surface-2 border-border-strong",
  danger: "bg-transparent text-nerf hover:bg-nerf-soft border-nerf/40",
  success: "bg-transparent text-buff hover:bg-buff-soft border-buff/40",
};

const SIZES: Record<Size, string> = {
  sm: "px-2.5 py-1 text-xs rounded-md gap-1.5",
  md: "px-4 py-2 text-sm rounded-lg gap-2",
};

export function Button({
  children,
  variant = "outline",
  size = "md",
  className = "",
  ...props
}: {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
