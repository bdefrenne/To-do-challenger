"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/statuses";
import type { Task } from "@/lib/types";

/** Archived task rows carry `parentId` (from the TaskDTO the API returns) so we
 *  can show only the roots of each archived subtree. */
type ArchivedTask = Task & { parentId?: string | null };

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

/**
 * Archived view — done tasks that were tucked away (Delete on a done task, or
 * "Archive done"). Un-archive sends one back to its board (with its subtree);
 * Delete removes it for good. Fetched independently of the live workspace store
 * so archived tasks never pollute the active boards.
 */
export default function ArchivedPage() {
  const { projects, refresh } = useWorkspace();
  const [tasks, setTasks] = useState<ArchivedTask[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { tasks } = await apiFetch<{ tasks: ArchivedTask[] }>(
      "/api/tasks?flat=1&archived=only",
    );
    // A subtree archive stamps every descendant, so hide children whose parent
    // is also archived — list only each subtree's root, newest-archived first.
    const ids = new Set(tasks.map((t) => t.id));
    const roots = tasks.filter((t) => !t.parentId || !ids.has(t.parentId));
    roots.sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
    setTasks(roots);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch on mount; setState runs after the await, not synchronously
    void load();
  }, [load]);

  const boardName = (id?: string | null) => {
    for (const p of projects) {
      const b = p.boards?.find((bd) => bd.id === id);
      if (b) return `${p.name} · ${b.name}`;
    }
    return "No board";
  };

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await fn();
      await load();
      await refresh(); // let the active boards pick up an un-archived task now
    } finally {
      setBusyId(null);
    }
  };

  const unarchive = (id: string) =>
    run(id, () =>
      apiFetch(`/api/tasks/${id}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived: false }),
      }),
    );

  const remove = (id: string, title: string) => {
    if (!confirm(`Delete “${title}” permanently? This can't be undone.`)) return;
    void run(id, () => apiFetch(`/api/tasks/${id}`, { method: "DELETE" }));
  };

  return (
    <div className="min-h-screen">
      <PageHeader
        title="Archived"
        subtitle="Done tasks you've tucked away. Un-archive to send one back to its board, or delete it for good."
      />
      <div className="px-8 py-6">
        <div className="mx-auto max-w-3xl">
          {tasks === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-faint">
              Nothing archived yet. Press Delete on a done task — or use “Archive done” on
              a board — to tuck it away here.
            </p>
          ) : (
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
                        {t.archivedAt
                          ? ` · archived ${new Date(t.archivedAt).toLocaleDateString()}`
                          : ""}
                      </div>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => unarchive(t.id)}
                      className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
                    >
                      Un-archive
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => remove(t.id, t.title)}
                      className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-red-600 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
