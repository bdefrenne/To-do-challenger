"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge, PointsChip } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { daysAgo, formatDue } from "@/lib/format";
import { STATUS_LABEL, STATUS_ORDER } from "@/lib/statuses";
import { useWorkspace, type TaskNode } from "./WorkspaceContext";

/**
 * The Today view shows ONLY the planned tasks (today's shortlist) + what's
 * in progress — not the whole backlog. Planned-but-unfinished tasks carry
 * over day to day. Click a task to open its detail + activity log.
 */
export function DailyFocus() {
  const { nodes, taskMap, openTask, start, toggleDone, setStatus } = useWorkspace();
  const [showDone, setShowDone] = useState(true);

  const top = (n: TaskNode) => n.parentId === null;

  const working = nodes
    .filter((n) => top(n) && n.status !== "backlog" && n.status !== "done")
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  const doneToday = nodes.filter(
    (n) =>
      top(n) &&
      n.status === "done" &&
      taskMap[n.id]?.updatedAt &&
      daysAgo(taskMap[n.id].updatedAt!) === 0,
  );

  return (
    <Card className="shadow-sm">
      <CardHeader
        title="Today's focus"
        hint="Only your planned tasks — carries over until done"
        right={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{working.length} tasks</Badge>
            <Link href="/">
              <Button variant="outline" size="sm">
                + Pick from list
              </Button>
            </Link>
          </div>
        }
      />

      <div className="p-4">
        {working.length === 0 ? (
          <div className="px-1 py-10 text-center">
            <p className="text-sm text-muted">No tasks planned for today yet.</p>
            <Link href="/" className="mt-3 inline-block">
              <Button variant="primary" size="sm">
                Go to All tasks to plan some
              </Button>
            </Link>
          </div>
        ) : (
          <ol className="space-y-2">
            {working.map((n) => {
              const t = taskMap[n.id];
              return (
                <FocusRow
                  key={n.id}
                  node={n}
                  title={t?.title ?? ""}
                  value={t?.value}
                  difficulty={t?.difficulty}
                  dueDate={t?.dueDate}
                  daysInStatus={daysAgo(n.statusSince)}
                  onOpen={() => openTask(n.id)}
                  onStart={() => start(n.id)}
                  onDone={() => toggleDone(n.id)}
                  onUnselect={() => setStatus(n.id, "backlog")}
                />
              );
            })}
          </ol>
        )}

        {doneToday.length > 0 ? (
          <div className="mt-4 border-t border-border pt-3">
            <button
              onClick={() => setShowDone((v) => !v)}
              className="text-[11px] font-medium uppercase tracking-wide text-faint hover:text-muted"
            >
              {showDone ? "▾" : "▸"} Done today · {doneToday.length}
            </button>
            {showDone ? (
              <ul className="mt-2 space-y-1">
                {doneToday.map((n) => (
                  <li key={n.id} className="flex items-center gap-2 px-1 text-sm">
                    <span className="text-buff">✓</span>
                    <button
                      onClick={() => openTask(n.id)}
                      className="text-faint hover:text-fg"
                    >
                      {taskMap[n.id]?.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function FocusRow({
  node,
  title,
  value,
  difficulty,
  dueDate,
  daysInStatus,
  onOpen,
  onStart,
  onDone,
  onUnselect,
}: {
  node: TaskNode;
  title: string;
  value?: import("@/lib/types").FibPoints;
  difficulty?: import("@/lib/types").FibPoints;
  dueDate?: string;
  daysInStatus: number;
  onOpen: () => void;
  onStart: () => void;
  onDone: () => void;
  onUnselect: () => void;
}) {
  const running = node.status === "building";
  const due = dueDate ? formatDue(dueDate) : null;
  return (
    <li
      className={[
        "group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        running
          ? "border-new/40 bg-new-soft/50"
          : "border-border bg-surface hover:border-border-strong",
      ].join(" ")}
    >
      <button
        onClick={onDone}
        aria-label="Mark done"
        className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border border-border-strong text-[10px] text-transparent transition-colors hover:border-buff hover:text-buff"
      >
        ✓
      </button>

      {!running ? (
        <button
          onClick={onStart}
          title="Start this task"
          className="shrink-0 text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        >
          ▶
        </button>
      ) : null}

      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          {value != null ? <PointsChip kind="value" points={value} /> : null}
          {difficulty != null ? <PointsChip kind="difficulty" points={difficulty} /> : null}
          <span className="truncate text-sm font-medium text-fg">{title}</span>
          {running ? <span className="shrink-0 text-xs text-new">● in progress</span> : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {due ? (
            <span className={due.overdue ? "text-nerf" : due.today ? "text-accent" : "text-faint"}>
              Due {due.label}
            </span>
          ) : null}
          {daysInStatus >= 1 ? (
            <Badge tone="amber">
              {daysInStatus}d in {STATUS_LABEL[node.status]}
            </Badge>
          ) : null}
        </div>
      </button>

      <button
        onClick={onUnselect}
        title="Send back to To Do"
        className="shrink-0 text-faint opacity-0 transition-opacity hover:text-nerf group-hover:opacity-100"
      >
        ✕
      </button>
    </li>
  );
}
