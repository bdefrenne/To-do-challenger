"use client";

import { useEffect, useState } from "react";

/** Tasks a board/project delete would destroy that no view shows. */
export type HiddenTasks = { archived: number; trashed: number };

/**
 * How many ARCHIVED and TRASHED tasks deleting this board/project would take
 * with it (TD2-214).
 *
 * They don't block the delete — they're out of every active view, so blocking on
 * them refused a delete while naming tasks nobody could find. But the row
 * cascade is the one exit that skips the Trash, so the human doing it is told
 * what's about to go. Null while unknown (not loaded, or the read failed): the
 * caller says nothing rather than guessing a number.
 *
 * Pass null when there's nothing to count (create mode) — the hook is a hook, so
 * it still has to be called unconditionally.
 */
export function useHiddenTaskCount(
  scope: { boardId?: string; projectId?: string } | null,
): HiddenTasks | null {
  // Keyed by the thing counted, so a stale answer for the PREVIOUS board can
  // never be read as this one's — it simply doesn't match, and reads as unknown.
  const [loaded, setLoaded] = useState<{ key: string; counts: HiddenTasks } | null>(null);
  const boardId = scope?.boardId;
  const projectId = scope?.projectId;
  const key = boardId ? `boardId=${boardId}` : projectId ? `projectId=${projectId}` : "";

  useEffect(() => {
    if (!key) return;
    let alive = true;
    fetch(`/api/tasks/hidden-count?${key}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: HiddenTasks | null) => {
        if (alive && d) {
          setLoaded({
            key,
            counts: { archived: Number(d.archived) || 0, trashed: Number(d.trashed) || 0 },
          });
        }
      })
      .catch(() => {
        /* leave it unknown — the confirm just won't name a count */
      });
    return () => {
      alive = false;
    };
  }, [key]);

  return loaded && loaded.key === key ? loaded.counts : null;
}

/** "1 archived task", "2 tasks in the Trash", "1 archived task and 2 in the
 *  Trash" — or "" when there's nothing hidden, or we don't know. */
export function hiddenTasksPhrase(h: HiddenTasks | null): string {
  if (!h) return "";
  const parts: string[] = [];
  if (h.archived > 0) parts.push(`${h.archived} archived task${h.archived === 1 ? "" : "s"}`);
  if (h.trashed > 0) {
    parts.push(
      parts.length
        ? `${h.trashed} in the Trash`
        : `${h.trashed} task${h.trashed === 1 ? "" : "s"} in the Trash`,
    );
  }
  return parts.join(" and ");
}
