"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { WorkspaceProvider, useWorkspace } from "./workspace/WorkspaceContext";
import { TaskDetailModal } from "./workspace/TaskDetailModal";
import { STATUS_ORDER } from "@/lib/statuses";

const NAV = [
  { href: "/", label: "All tasks", icon: "☰" },
  { href: "/today", label: "Today", icon: "◎" },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 overflow-x-hidden">{children}</main>
      </div>
      <TaskDetailModal />
    </WorkspaceProvider>
  );
}

function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-white">
          ✓
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">
            To-do Challenger
          </div>
          <div className="text-[11px] text-faint">Personal workspace</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-3 py-2">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={[
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-muted hover:bg-surface-2 hover:text-fg",
              ].join(" ")}
            >
              <span
                className={`text-base ${active ? "text-accent" : "text-faint"}`}
              >
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <StatusLegend />

      <div className="mt-auto flex items-center gap-2.5 border-t border-border px-4 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
          Y
        </div>
        <div className="leading-tight">
          <div className="text-sm font-medium text-fg">You</div>
          <div className="text-[11px] text-faint">Free plan</div>
        </div>
      </div>
    </aside>
  );
}

/** A tiny live count of tasks per status — calm context in the sidebar. */
function StatusLegend() {
  const { nodes } = useWorkspace();
  const count = (s: string) => nodes.filter((n) => n.status === s).length;
  return (
    <div className="mt-4 px-5">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
        Statuses
      </div>
      <ul className="space-y-1.5">
        {STATUS_ORDER.map((s) => (
          <li
            key={s}
            className="flex items-center justify-between text-xs text-muted"
          >
            <span className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${DOT[s]}`} />
              {LABEL[s]}
            </span>
            <span className="nums text-faint">{count(s)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LABEL: Record<string, string> = {
  "in-progress": "In Progress",
  planned: "Planned",
  backlog: "To Do",
  done: "Complete",
};
const DOT: Record<string, string> = {
  "in-progress": "bg-new",
  planned: "bg-accent",
  backlog: "bg-slate-400",
  done: "bg-buff",
};
