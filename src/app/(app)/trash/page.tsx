"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/statuses";
import type { Task } from "@/lib/types";

/** Trash rows carry `parentId` (from the TaskDTO the API returns) so we can list
 *  only the root of each deleted subtree — a deleted parent takes its children
 *  with it, and they come back together. */
type TrashedTask = Task & { parentId?: string | null };

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") window.location.href = "/login";
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

/** "3 minutes ago" / "2 days ago" — the age of a delete, which is what you're
 *  actually reading this list for ("the one I just deleted"). */
function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const steps: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
  ];
  let v = secs;
  let unit = "second";
  for (const [size, next] of steps) {
    if (v < size) break;
    v /= size;
    unit = next;
  }
  const n = Math.floor(v);
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * Trash — every deleted task, newest deleted first, restorable one at a time.
 *
 * Deleting a task is a soft delete now (`deletedAt`): it leaves every board,
 * list, canvas and search but keeps its id, ref, activity and subtree, so
 * Restore puts the whole branch back where it was. Only "Empty trash" here
 * actually destroys anything.
 *
 * Fetched independently of the live workspace store, the way the Archived view
 * is, so deleted tasks can never leak into the active boards.
 */
export default function TrashPage() {
  const { projects, refresh } = useWorkspace();
  const [tasks, setTasks] = useState<TrashedTask[] | null>(null);
  /** How many rows the big button would destroy — every deleted task, not just
   *  the subtree roots the list shows. */
  const [total, setTotal] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);

  const load = useCallback(async () => {
    const { tasks } = await apiFetch<{ tasks: TrashedTask[] }>(
      "/api/tasks?flat=1&deleted=only",
    );
    // A delete stamps the whole subtree, so a child whose parent is also in the
    // bin isn't its own entry — it's part of that parent's branch.
    const ids = new Set(tasks.map((t) => t.id));
    const roots = tasks.filter((t) => !t.parentId || !ids.has(t.parentId));
    roots.sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
    setTasks(roots);
    setTotal(tasks.length);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch on mount; setState runs after the await, not synchronously
    void load();
  }, [load]);

  const boardName = useMemo(() => {
    return (id?: string | null) => {
      for (const p of projects) {
        const b = p.boards?.find((bd) => bd.id === id);
        if (b) return `${p.name} · ${b.name}`;
      }
      return "No board";
    };
  }, [projects]);

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await fn();
      await load();
      await refresh(); // let the active boards pick up a restored task now
    } finally {
      setBusyId(null);
    }
  };

  const restore = (id: string) =>
    run(id, () => apiFetch(`/api/tasks/${id}/restore`, { method: "POST" }));

  const purge = (id: string, title: string) => {
    if (!confirm(`Delete “${title}” forever? Its subtasks, activity and images go too.`))
      return;
    void run(id, () => apiFetch(`/api/tasks/${id}?forever=1`, { method: "DELETE" }));
  };

  const empty = async () => {
    if (
      !confirm(
        `Delete ${total} task${total === 1 ? "" : "s"} forever? This can't be undone.`,
      )
    )
      return;
    setEmptying(true);
    try {
      await apiFetch<{ purged: number }>("/api/tasks/trash", { method: "DELETE" });
      await load();
    } finally {
      setEmptying(false);
    }
  };

  return (
    <div className="min-h-screen">
      <PageHeader
        title="Trash"
        subtitle="Tasks you deleted, newest first. Restore one to put it back on its board — with its subtasks — or empty the trash to delete everything for good."
      />
      <div className="px-8 py-6">
        <div className="mx-auto max-w-3xl">
          {tasks === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-faint">
              The trash is empty. Anything you delete lands here first, so a delete is
              never the last word.
            </p>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg">
                    {total} task{total === 1 ? "" : "s"} in the trash
                  </div>
                  <div className="text-[11px] text-faint">
                    Emptying deletes them permanently — subtasks, activity and images
                    included. There is no undo.
                  </div>
                </div>
                <button
                  disabled={emptying}
                  onClick={() => void empty()}
                  className="shrink-0 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {emptying ? "Emptying…" : "Empty trash"}
                </button>
              </div>
              <ul className="space-y-1.5">
                {tasks.map((t) => {
                  const tone = STATUS_TONE[t.status];
                  const busy = busyId === t.id;
                  return (
                    <li
                      key={t.id}
                      className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2"
                    >
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium ${tone.bg} ${tone.text} ${tone.border}`}
                      >
                        {STATUS_LABEL[t.status]}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-fg">{t.title}</div>
                        <div className="truncate text-[11px] text-faint">
                          {boardName(t.boardId)}
                          {t.deletedAt ? ` · deleted ${ago(t.deletedAt)}` : ""}
                        </div>
                      </div>
                      <button
                        disabled={busy}
                        onClick={() => restore(t.id)}
                        className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
                      >
                        Restore
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => purge(t.id, t.title)}
                        className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-red-600 disabled:opacity-50"
                      >
                        Delete forever
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
