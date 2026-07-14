import type { ReactNode } from "react";

/** Consistent page title row across the three screens. */
export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border px-8 py-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex items-center gap-3">{right}</div> : null}
    </header>
  );
}
