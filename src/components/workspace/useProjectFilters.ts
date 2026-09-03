"use client";

/**
 * WHOSE work and WHICH boards a project's views are showing (TD2-216).
 *
 * One state owner for the whole project: the List, Boards and Done views and
 * the project's canvas all read this hook, keyed by project id, so turning a
 * filter on in one and switching to another keeps it on. That's the point of
 * lifting it here rather than letting each view hold its own — a filter that
 * resets when you change view is a filter you stop trusting.
 *
 * Persisted through `useViewMode`, the same localStorage-backed hook the view
 * toggles and the collapse state use: the hydration snapshot is "no filter" (so
 * no mismatch), the stored choice takes over on the client, and a write nudges
 * every other component bound to the same key — which is what keeps a project
 * page and its canvas in step in two tabs.
 *
 * Both filters are RENDER-only. Nothing here may reach a writer: in particular
 * `CanvasEditor`'s lane reconciler sweeps any machine lane whose board isn't in
 * the board list it reads, so the filtered set must never be handed to it (see
 * `src/lib/task-filters.ts`).
 */

import { useCallback, useMemo } from "react";
import type { Board } from "@/lib/types";
import { useViewMode } from "@/components/ui/ViewToggle";

/** Stored value meaning "every board", including ones created later.
 *
 *  Deliberately a sentinel rather than the full list of ids: storing "all" as
 *  "b1,b2,b3" would silently HIDE the next board added to the project, and the
 *  person who added it would have no idea a filter was to blame. */
const ALL_BOARDS = "";

export interface ProjectFilters {
  /** The one person being shown, or null for everyone. Single-select, exactly
   *  as the canvas has had it since TD-59. */
  assigneeId: string | null;
  setAssigneeId: (id: string | null) => void;
  /** The boards being shown, or null for "all of them" — null is not the same
   *  as "every current id", see `ALL_BOARDS`. */
  boardIds: string[] | null;
  setBoardIds: (ids: string[] | null) => void;
  /** Is this board being drawn? True for everything while no board filter is
   *  set, so callers can use it unconditionally. A task with no board at all
   *  (`null`) rides with the "all boards" case and is hidden by any narrowing —
   *  it belongs to no board, so no board selection can be said to include it. */
  isBoardVisible: (boardId: string | null) => boolean;
  /** The given boards, narrowed — what a view should actually draw. */
  visibleBoards: Board[];
  /** True while either filter is narrowing something, for the "showing a subset"
   *  affordances (counts, empty states, a disabled reorder handle). */
  active: boolean;
}

export function useProjectFilters(
  projectId: string,
  boards: Board[],
): ProjectFilters {
  const [assigneeRaw, setAssigneeRaw] = useViewMode<string>(
    `filter-assignee:${projectId}`,
    "",
  );
  const [boardsRaw, setBoardsRaw] = useViewMode<string>(
    `filter-boards:${projectId}`,
    ALL_BOARDS,
  );

  const assigneeId = assigneeRaw || null;
  const setAssigneeId = useCallback(
    (id: string | null) => setAssigneeRaw(id ?? ""),
    [setAssigneeRaw],
  );

  /* Stored ids are intersected with the boards that actually exist: a board can
     be deleted, or put away (TD2-213), while a selection naming it sits in
     localStorage. And a selection that survives none of them falls back to ALL
     rather than to nothing — a view stuck permanently empty, with a control
     that reads "0 boards", is indistinguishable from a bug. */
  const boardIds = useMemo(() => {
    if (boardsRaw === ALL_BOARDS) return null;
    const live = new Set(boards.map((b) => b.id));
    const kept = boardsRaw.split(",").filter((id) => live.has(id));
    return kept.length ? kept : null;
  }, [boardsRaw, boards]);

  const setBoardIds = useCallback(
    (ids: string[] | null) => setBoardsRaw(ids === null ? ALL_BOARDS : ids.join(",")),
    [setBoardsRaw],
  );

  const selected = useMemo(() => (boardIds ? new Set(boardIds) : null), [boardIds]);
  const isBoardVisible = useCallback(
    (boardId: string | null) => !selected || (boardId !== null && selected.has(boardId)),
    [selected],
  );

  const visibleBoards = useMemo(
    () => (selected ? boards.filter((b) => selected.has(b.id)) : boards),
    [boards, selected],
  );

  return {
    assigneeId,
    setAssigneeId,
    boardIds,
    setBoardIds,
    isBoardVisible,
    visibleBoards,
    active: assigneeId !== null || boardIds !== null,
  };
}
