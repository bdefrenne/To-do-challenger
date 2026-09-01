"use client";

/**
 * The project's boards, each with a show/hide switch (TD2-213).
 *
 * A project accumulates boards faster than it retires them — a game that
 * shipped, a prototype that stalled, a client that went quiet — and because
 * every canvas tray holds a lane for EVERY board (TD-138), a dormant one costs
 * a column in every band of the Boards view and a lane in every tray. Deleting
 * isn't the answer: it's refused while the board holds tasks, and rightly so.
 *
 * So a board can be PUT AWAY instead. It keeps its tasks, its refs, its history
 * and its own page; it just stops being drawn — no column, no lane, no sidebar
 * entry. This list is the only place a hidden board is shown, which makes it the
 * only place it can come back from.
 *
 * Toggling writes IMMEDIATELY, not on Save. This isn't a field of the project
 * being edited — it's a property of each board, and the same modal's Save
 * handler writes the project. Batching it would mean either a second thing for
 * Save to mean or a change that silently doesn't happen if you close the modal,
 * and it behaves like the Boards view's drag handle, which also persists on
 * release.
 */

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Avatar } from "@/components/ui/Badge";
import { useWorkspace } from "./WorkspaceContext";
import type { Board, Project } from "@/lib/types";

export function BoardVisibilityField({ project }: { project: Project }) {
  const { renameBoard } = useWorkspace();
  // Which rows are mid-write. The workspace refetches projects after a PATCH,
  // so the row's own state comes from `project`; this only disables the button
  // for the round trip so a double-click can't queue two opposite writes.
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const visible = project.boards ?? [];
  const hidden = project.hiddenBoards ?? [];
  // Visible first, then the put-away ones — the list reads as "what this project
  // shows" followed by "what it's keeping".
  const rows: { board: Board; isHidden: boolean }[] = [
    ...visible.map((board) => ({ board, isHidden: false })),
    ...hidden.map((board) => ({ board, isHidden: true })),
  ];

  const toggle = async (board: Board, isHidden: boolean) => {
    setBusy((prev) => new Set(prev).add(board.id));
    try {
      await renameBoard(board.id, { hidden: !isHidden });
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(board.id);
        return next;
      });
    }
  };

  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-muted">
        Boards{" "}
        <span className="text-faint">
          (hidden boards keep their tasks &mdash; they just aren&rsquo;t drawn on
          this project&rsquo;s views, its canvas or the sidebar)
        </span>
      </span>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-bg p-1">
        {rows.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-faint">No boards yet.</p>
        ) : (
          rows.map(({ board, isHidden }) => {
            const pending = busy.has(board.id);
            return (
              <div
                key={board.id}
                className={[
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  isHidden ? "opacity-50" : "",
                ].join(" ")}
              >
                <Avatar
                  name={board.name}
                  size={20}
                  imageUrl={board.image}
                  color={board.color}
                />
                <span className="min-w-0 flex-1 truncate text-fg">
                  {board.name}
                </span>
                {board.code ? (
                  <span className="shrink-0 font-mono text-[11px] text-faint">
                    {board.code}
                  </span>
                ) : null}
                {isHidden ? (
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-faint">
                    Hidden
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => void toggle(board, isHidden)}
                  disabled={pending}
                  aria-pressed={isHidden}
                  title={
                    isHidden
                      ? `Show “${board.name}” again`
                      : `Hide “${board.name}” — it keeps its tasks, and stops appearing on this project's views and canvas`
                  }
                  className="shrink-0 cursor-pointer rounded-md border border-border px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
                >
                  {isHidden ? (
                    <Eye aria-hidden size={13} strokeWidth={1.75} />
                  ) : (
                    <EyeOff aria-hidden size={13} strokeWidth={1.75} />
                  )}
                  <span className="sr-only">{isHidden ? "Show" : "Hide"}</span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
