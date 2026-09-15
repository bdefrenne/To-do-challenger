"use client";

import { useMemo, useState } from "react";
import { useWorkspace } from "./WorkspaceContext";
import { sweepableDoneIds } from "@/lib/sweep";
import {
  placementOfTask,
  placementTitle,
  type PlacementMap,
  type PlacementTitles,
} from "@/lib/sections";
import type { Board } from "@/lib/types";

/**
 * "Clear Done (N)" — the project's whole ladder swept into DONE THIS WEEK in one
 * go (TD2-218), rather than one board column at a time.
 *
 * Same move as a column's own sweep, same two-step exit for finished work: this
 * PARKS cards in the tray (nothing is archived, deleted, or changed in status),
 * and the header's "Archive done" is the step after it.
 *
 * Deliberately NOT filtered. A column's button says "clear what's in this
 * column", so it must mean the cards on screen and it honours the view's
 * filters; this one says "clear the project", and a sweep that quietly skipped
 * the boards someone's board filter was hiding — or everyone else's cards under
 * an assignee filter — would leave finished work behind under a button that
 * claims the opposite. So the scope is every board the project SHOWS
 * (`project.boards`, per TD2-213 — a hidden board is drawn nowhere, including
 * the tray it would be swept into) and everyone's cards.
 *
 * The tray itself is excluded: it is where this sends things.
 */
export function ClearDoneButton({
  boards,
  placements,
  titles,
}: {
  /** The project's boards — what the project shows, filters ignored. */
  boards: Board[];
  placements: PlacementMap;
  titles: PlacementTitles;
}) {
  const { nodes, taskMap, pendingPlacements, fileTasks } = useWorkspace();
  const [busy, setBusy] = useState(false);

  const ids = useMemo(() => {
    const boardIds = new Set(boards.map((b) => b.id));
    const parentOf = (id: string) =>
      nodes.find((n) => n.id === id)?.parentId ?? null;
    const placementOf = (id: string) =>
      pendingPlacements[id] ??
      placementOfTask(id, taskMap, parentOf, placements);
    return sweepableDoneIds(nodes, {
      inScope: (n) =>
        n.boardId !== null &&
        boardIds.has(n.boardId) &&
        // Already parked — this is where it would be sent.
        placementOf(n.id) !== "doneThisWeek",
      pinned: (id) => taskMap[id]?.canvasSectionId != null,
    });
  }, [boards, nodes, taskMap, placements, pendingPlacements]);

  if (!ids.length) return null;

  const tray = placementTitle(titles, "doneThisWeek");

  return (
    <button
      disabled={busy}
      onClick={async () => {
        const n = ids.length;
        // The column sweep's dialog, at project scale — and for the same reason:
        // nothing catches a clear afterwards the way the undo toast catches an
        // archive, and this one moves every board's cards at once.
        if (
          !confirm(
            `Clear ${n} done task${n === 1 ? "" : "s"} across ${boards.length} board${boards.length === 1 ? "" : "s"}?\n\n` +
              `${n === 1 ? "It moves" : "They move"} to ${tray}. ` +
              `Still on the board, still done — nothing is archived, deleted, or ` +
              `changed in status.`,
          )
        )
          return;
        setBusy(true);
        try {
          await fileTasks(ids, "doneThisWeek");
        } finally {
          setBusy(false);
        }
      }}
      title={`Move every done card in this project to ${tray} — ${ids.length} card${ids.length === 1 ? "" : "s"}, across all of its boards`}
      className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
    >
      {busy ? "Clearing…" : `Clear Done (${ids.length})`}
    </button>
  );
}
