"use client";

import { useEffect, useRef, useState } from "react";

/** A project and the boards a task could move to within it. */
export interface BoardGroup {
  projectId: string;
  projectName: string;
  boards: { id: string; name: string }[];
}

/**
 * Clickable board chip with a small change-board menu — the board-column analog
 * of {@link StatusPill}. Always shown on list rows.
 *
 *   • One group  → the task already has a board; the menu lists that project's
 *     other boards (change within the same project).
 *   • Many groups → the task has no board; the menu is a two-step drill-down:
 *     pick a project, then a board within it.
 */
export function BoardPill({
  currentBoardId,
  currentBoardName,
  groups,
  onChange,
}: {
  currentBoardId: string | null;
  /** Resolved name of the current board; null → render "No board". */
  currentBoardName: string | null;
  /** Selectable destinations, grouped by project. */
  groups: BoardGroup[];
  /** Move the task onto `boardId` (no-op if it's already the current board). */
  onChange: (boardId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Drill-down: which project's boards are showing (multi-group case).
  const [projectId, setProjectId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function close() {
    setOpen(false);
    setProjectId(null);
  }

  function pick(boardId: string) {
    onChange(boardId);
    close();
  }

  const single = groups.length === 1;
  // In single-group mode, show its boards directly; otherwise wait for a project pick.
  const activeGroup = single
    ? groups[0]
    : (groups.find((g) => g.projectId === projectId) ?? null);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => (v ? (close(), false) : true));
        }}
        title={currentBoardName ? `Board: ${currentBoardName}` : "No board — click to assign"}
        className={`rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium hover:bg-surface-2 ${
          currentBoardName ? "bg-surface-2 text-muted" : "bg-transparent text-faint italic"
        }`}
      >
        {currentBoardName ?? "No board"}
      </button>

      {open ? (
        <div
          className="absolute z-30 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {activeGroup ? (
            <>
              {/* Step 2 header (only when drilled into a project). */}
              {!single ? (
                <button
                  onClick={() => setProjectId(null)}
                  className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs text-faint hover:text-fg"
                >
                  ‹ <span className="truncate font-medium">{activeGroup.projectName}</span>
                </button>
              ) : null}
              {activeGroup.boards.length === 0 ? (
                <p className="px-3 py-1.5 text-xs text-faint">No boards in this project</p>
              ) : (
                activeGroup.boards.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => pick(b.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-2 ${
                      b.id === currentBoardId ? "font-semibold" : ""
                    }`}
                  >
                    <span className="truncate text-fg">{b.name}</span>
                    {b.id === currentBoardId ? (
                      <span className="ml-auto text-accent">✓</span>
                    ) : null}
                  </button>
                ))
              )}
            </>
          ) : (
            // Step 1: choose a project (multi-group / no-board case).
            <>
              <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-faint">
                Choose a project
              </p>
              {groups.length === 0 ? (
                <p className="px-3 py-1.5 text-xs text-faint">No projects yet</p>
              ) : (
                groups.map((g) => (
                  <button
                    key={g.projectId}
                    onClick={() => setProjectId(g.projectId)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-2"
                  >
                    <span className="truncate text-fg">{g.projectName}</span>
                    <span className="ml-auto text-faint">›</span>
                  </button>
                ))
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
