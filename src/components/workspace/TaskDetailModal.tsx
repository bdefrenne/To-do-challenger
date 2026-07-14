"use client";

import { useEffect } from "react";
import type { TaskLogEntry } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Avatar, PriorityFlag, TagChip } from "@/components/ui/Badge";
import { formatTime, formatShortDate, formatAge, formatDue } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/statuses";
import { StatusPill } from "./StatusPill";
import { useWorkspace } from "./WorkspaceContext";

const LOG_ICON: Record<TaskLogEntry["kind"], string> = {
  created: "✦",
  status: "↻",
  moved: "⇄",
  nested: "⤵",
  started: "▶",
  paused: "⏸",
  done: "✓",
  reopened: "↺",
};

const LOG_COLOR: Record<TaskLogEntry["kind"], string> = {
  created: "text-new",
  status: "text-accent",
  moved: "text-accent",
  nested: "text-accent",
  started: "text-new",
  paused: "text-muted",
  done: "text-buff",
  reopened: "text-adjust",
};

/** Full task detail modal — opens on row click. Rendered once globally (in AppShell). */
export function TaskDetailModal() {
  const {
    openTaskId,
    openTask,
    closeTask,
    taskMap,
    logs,
    nodeById,
    start,
    toggleDone,
    setStatus,
    childrenOf,
  } = useWorkspace();

  useEffect(() => {
    if (!openTaskId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeTask();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openTaskId, closeTask]);

  if (!openTaskId) return null;
  const task = taskMap[openTaskId];
  const node = nodeById(openTaskId);
  if (!task || !node) return null;

  const entries = [...(logs[openTaskId] ?? [])].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
  const kids = childrenOf(openTaskId);
  const done = node.status === "done";
  const due = task.dueDate ? formatDue(task.dueDate) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-6 backdrop-blur-sm"
      onClick={closeTask}
    >
      <div
        className="mt-12 w-full max-w-2xl rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              {(task.tags ?? []).map((t) => (
                <TagChip key={t} id={t} />
              ))}
            </div>
            <h2 className="text-lg font-semibold tracking-tight">{task.title}</h2>
          </div>
          <button
            onClick={closeTask}
            className="shrink-0 rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-[1fr_240px]">
          {/* Left: details */}
          <div className="space-y-5">
            {/* actions */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={node.status} onChange={(s) => setStatus(openTaskId, s)} />
              {node.status !== "in-progress" && !done ? (
                <Button variant="primary" size="sm" onClick={() => start(openTaskId)}>
                  ▶ Start
                </Button>
              ) : null}
              <Button variant="success" size="sm" onClick={() => toggleDone(openTaskId)}>
                {done ? "↺ Reopen" : "✓ Mark done"}
              </Button>
            </div>

            {/* description */}
            {task.description ? (
              <div>
                <SectionLabel>Description</SectionLabel>
                <p className="mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg">
                  {task.description}
                </p>
              </div>
            ) : null}

            {/* subtasks */}
            {kids.length > 0 ? (
              <div>
                <SectionLabel>Sub-tasks · {kids.length}</SectionLabel>
                <ul className="mt-1 space-y-1">
                  {kids.map((k) => (
                    <li
                      key={k.id}
                      className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm"
                    >
                      <StatusPill status={k.status} onChange={(s) => setStatus(k.id, s)} compact />
                      <button
                        onClick={() => openTask(k.id)}
                        className="truncate text-left text-fg hover:underline"
                      >
                        {taskMap[k.id]?.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* activity log */}
            <div>
              <SectionLabel>Activity · {entries.length}</SectionLabel>
              <ol className="relative mt-2 space-y-1 before:absolute before:left-[11px] before:top-1 before:bottom-1 before:w-px before:bg-border">
                {entries.map((e) => (
                  <li key={e.id} className="relative flex gap-3 py-1">
                    <span
                      className={`z-10 grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border border-border bg-surface text-[11px] ${LOG_COLOR[e.kind]}`}
                    >
                      {LOG_ICON[e.kind]}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-fg">{e.message}</div>
                      <div className="text-[11px] text-faint">
                        {formatShortDate(e.at)} · {formatTime(e.at)}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          {/* Right: meta */}
          <div className="space-y-3">
            <Meta label="Status">
              <StatusPill status={node.status} onChange={(s) => setStatus(openTaskId, s)} />
            </Meta>
            {task.priority ? (
              <Meta label="Priority">
                <PriorityFlag priority={task.priority} withLabel />
              </Meta>
            ) : null}
            {task.assignee ? (
              <Meta label="Assignee">
                <span className="flex items-center gap-2">
                  <Avatar name={task.assignee} size={20} />
                  {task.assignee}
                </span>
              </Meta>
            ) : null}
            {due ? (
              <Meta label="Due">
                <span
                  className={
                    done
                      ? "text-faint"
                      : due.overdue
                        ? "font-medium text-nerf"
                        : due.today
                          ? "font-medium text-accent"
                          : "text-fg"
                  }
                >
                  {due.label}
                </span>
              </Meta>
            ) : null}
            <Meta label="In status">
              <span className="nums">{formatAge(node.statusSince)}</span> in{" "}
              {STATUS_LABEL[node.status]}
            </Meta>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
      {children}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 text-sm text-fg">{children}</div>
    </div>
  );
}
