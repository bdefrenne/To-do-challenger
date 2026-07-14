import type { ReactNode } from "react";

/** A surface panel. The basic building block of every screen. */
export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag
      className={`rounded-xl border border-border bg-surface ${className}`}
    >
      {children}
    </Tag>
  );
}

/** Optional header row for a Card: title on the left, actions on the right. */
export function CardHeader({
  title,
  hint,
  right,
}: {
  title: ReactNode;
  hint?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-fg">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}
