/**
 * Canvas Section membership — deciding which Section shows which tasks.
 *
 * A Section doesn't OWN its tasks, it resolves them. `tasks.canvas_section_id`
 * pins a task to one Section node, but null is the normal state: an unpinned
 * task resolves into its board's **INBOX lane**, so a task created from the
 * REST API, the MCP server, a Kanban column or the All-tasks row is visible on
 * the canvas without anyone having tagged it. Pinning is an explicit override,
 * written only when someone drags a card into a Section.
 *
 * Two rules make the resolution total — every task lands somewhere, or is
 * counted as unplaced, never silently dropped:
 *
 *   1. **A pin only counts on its own canvas.** Node ids from other canvases
 *      (and from deleted nodes) are indistinguishable from live ones, so a pin
 *      we can't find among THIS canvas's nodes reads as unpinned. That's what
 *      makes a second canvas work, and what makes deleting a Section return its
 *      cards to the inbox instead of orphaning them.
 *   2. **Children inherit their parent's placement.** A subtask has no pin of
 *      its own until someone drags it somewhere, so it simply lives wherever its
 *      parent lives. This is why adding a subtask from the detail modal doesn't
 *      need to know about canvases at all.
 */

import type { CanvasNode, Task } from "./types";

/** The `data` flag marking the INBOX group and its lanes. Set on both the
 *  `section_group` container and each `section` lane inside it. */
export const isInboxNode = (n: Pick<CanvasNode, "data">): boolean =>
  n.data?.inbox === true;

/** A lane's board, or null for the "No board" lane (tasks created with no
 *  board at all — what the All-tasks add row produces). */
export const laneBoardId = (n: Pick<CanvasNode, "data">): string | null =>
  (n.data?.boardId as string | undefined) ?? null;

/** Stable id for a canvas's INBOX group. Derived rather than random so two
 *  clients reconciling at the same time converge on ONE group: storage is a
 *  LiveMap keyed by node id, so the same key is the same entry. */
export const inboxGroupId = (canvasId: string): string => `inbox-${canvasId}`;

/** Stable id for one board's lane inside a canvas's INBOX group. Same
 *  convergence argument as `inboxGroupId`. */
export const inboxLaneId = (canvasId: string, boardId: string | null): string =>
  `inbox-${canvasId}-${boardId ?? "noboard"}`;

/**
 * The Section a task is pinned to, or null for "not placed".
 *
 * Reads only the first-class column. It does NOT fall back to the pre-0027
 * `customFields.sectionId` tag: migration 0027 backfilled the column from that
 * tag, so the column is authoritative for every existing row, and a fallback
 * would make "deliberately unpinned" (column null, stale tag still in the bag)
 * indistinguishable from "written by old code" — resurrecting pins the user
 * just cleared.
 */
export const pinnedSectionId = (task: Task | undefined): string | null =>
  task?.canvasSectionId ?? null;

/** The minimum a task needs for placement — matches WorkspaceContext's TaskNode. */
export interface PlaceableTask {
  id: string;
  parentId: string | null;
  boardId: string | null;
}

export interface SectionMembership {
  /** Section node id → the ids of every task that Section shows, at any depth. */
  bySection: Map<string, Set<string>>;
  /** Tasks this canvas can't show: their board has no lane and they aren't
   *  pinned. Surfaced as a count so "invisible" is never silent. */
  unplaced: Set<string>;
}

/**
 * Resolve every task to at most one Section on this canvas, in one pass.
 *
 * O(tasks + nodes) with memoised parent-chain walks, computed once per
 * task/node change — a per-Section scan would be O(sections × tasks), and this
 * canvas already has 18 sections against hundreds of tasks.
 */
export function buildSectionMembership(
  canvasNodes: readonly CanvasNode[],
  tasks: readonly PlaceableTask[],
  taskMap: Record<string, Task>,
): SectionMembership {
  const sectionsOnCanvas = new Set<string>();
  const laneByBoard = new Map<string | null, string>();
  for (const n of canvasNodes) {
    if (n.kind !== "section") continue;
    sectionsOnCanvas.add(n.id);
    if (isInboxNode(n)) laneByBoard.set(laneBoardId(n), n.id);
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, string | null>();

  /** Where this task renders: its own live pin, else wherever its parent
   *  renders, else its board's inbox lane. `seen` guards a corrupt parent
   *  cycle so a bad row can't hang the canvas. */
  const placementOf = (id: string, seen: Set<string>): string | null => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return null;
    seen.add(id);

    const t = byId.get(id);
    if (!t) return null;

    const pin = pinnedSectionId(taskMap[id]);
    let placed: string | null =
      pin && sectionsOnCanvas.has(pin) ? pin : null;
    if (placed === null && t.parentId) placed = placementOf(t.parentId, seen);
    if (placed === null) placed = laneByBoard.get(t.boardId) ?? null;

    memo.set(id, placed);
    return placed;
  };

  const bySection = new Map<string, Set<string>>();
  const unplaced = new Set<string>();
  for (const t of tasks) {
    const sectionId = placementOf(t.id, new Set());
    if (sectionId === null) {
      unplaced.add(t.id);
      continue;
    }
    let set = bySection.get(sectionId);
    if (!set) bySection.set(sectionId, (set = new Set()));
    set.add(t.id);
  }
  return { bySection, unplaced };
}

/** An empty membership — used before a canvas's nodes have loaded, and by the
 *  board views, which don't do section resolution at all. */
export const EMPTY_MEMBERSHIP: SectionMembership = {
  bySection: new Map(),
  unplaced: new Set(),
};

/**
 * Which boards need an INBOX lane on this canvas: those with at least one task
 * that no *work* Section claims. `null` in the result means board-less tasks,
 * which need the "No board" lane.
 *
 * Deliberately resolved against work Sections only. Asking "which lanes do we
 * need?" of a membership that already includes lanes is circular — the lanes
 * would absorb the very tasks that justify them, so every lane would look
 * unnecessary the moment it existed.
 */
export function boardsNeedingInbox(
  canvasNodes: readonly CanvasNode[],
  tasks: readonly PlaceableTask[],
  taskMap: Record<string, Task>,
): Set<string | null> {
  const workSections = canvasNodes.filter((n) => n.kind === "section" && !isInboxNode(n));
  const { unplaced } = buildSectionMembership(workSections, tasks, taskMap);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const boards = new Set<string | null>();
  for (const id of unplaced) {
    const t = byId.get(id);
    if (t) boards.add(t.boardId);
  }
  return boards;
}
