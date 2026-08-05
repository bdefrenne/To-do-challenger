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

import type { CanvasNode, Task, TaskStatus } from "./types";

/* --------------------------- System groups ---------------------------
 * Three groups on every canvas are MACHINE-MANAGED: the editor creates them,
 * names them, and keeps one lane per board inside each. They're the triage
 * destinations — where a card goes when it isn't scheduled:
 *
 *   INBOX           untriaged. The odd one out: its lanes mean "unpinned", so a
 *                   task lands here by having no pin at all (`isInboxNode`).
 *   BACKLOG         triaged, not scheduled. A real pin.
 *   LATER           deliberately deferred. A real pin.
 *   DONE THIS WEEK  finished, not yet swept. The holding pen that makes deleting
 *                   a done card a two-step move (see `deletionOf`).
 *
 * THIS WEEK is deliberately NOT one of these — it's hand-curated (the user makes
 * the group, names it, stars it) and lives further down this file.
 *
 * Each group carries its kind as a `data` flag (`data.backlog === true`), set on
 * the `section_group` AND on every lane inside it, so a node can be classified
 * without walking to its parent. */
export type SystemGroup = "inbox" | "backlog" | "later" | "doneThisWeek";

/** The four kinds in display order — also the order they're stacked down the
 *  left of a canvas: what's arriving, what's parked, what's finished. */
export const SYSTEM_GROUPS: readonly SystemGroup[] = [
  "inbox",
  "backlog",
  "later",
  "doneThisWeek",
];

/** Header text for each system group's container. */
export const SYSTEM_GROUP_TITLE: Record<SystemGroup, string> = {
  inbox: "INBOX",
  backlog: "BACKLOG",
  later: "LATER",
  doneThisWeek: "DONE THIS WEEK",
};

/** Which system group a node belongs to, or null for an ordinary user node.
 *  Reads the flag off the node itself — true for both the group and its lanes. */
export const systemGroupOf = (
  n: Pick<CanvasNode, "data">,
): SystemGroup | null => {
  for (const kind of SYSTEM_GROUPS) if (n.data?.[kind] === true) return kind;
  return null;
};

/**
 * The `data` flag marking the INBOX group and its lanes.
 *
 * Kept as its own predicate — NOT folded into `systemGroupOf` — because it means
 * something the other two don't: an INBOX lane shows its board's **unpinned**
 * tasks, so dropping into one *clears* the pin (`pinFor`) and a task resolves
 * into one by fall-through, never by pointing at it. BACKLOG and LATER lanes are
 * ordinary pin targets. Use `systemGroupOf` for anything cosmetic or protective;
 * use this one only where "unpinned" is the actual question.
 */
export const isInboxNode = (n: Pick<CanvasNode, "data">): boolean =>
  n.data?.inbox === true;

/** A lane's board, or null for the "No board" lane (tasks created with no
 *  board at all — what the All-tasks add row produces). */
export const laneBoardId = (n: Pick<CanvasNode, "data">): string | null =>
  (n.data?.boardId as string | undefined) ?? null;

/** Stable id for one of a canvas's system groups. Derived rather than random so
 *  two clients reconciling at the same time converge on ONE group: storage is a
 *  LiveMap keyed by node id, so the same key is the same entry. */
export const systemGroupId = (kind: SystemGroup, canvasId: string): string =>
  `${kind}-${canvasId}`;

/** Stable id for one board's lane inside a system group. Same convergence
 *  argument as `systemGroupId` — and, for BACKLOG/LATER, the same server-pins-a-
 *  node-that-doesn't-exist-yet trick as `weekLaneId` below. */
export const systemLaneId = (
  kind: SystemGroup,
  canvasId: string,
  boardId: string | null,
): string => `${kind}-${canvasId}-${boardId ?? "noboard"}`;

/** What pressing DELETE on a card actually does. */
export type DeleteAction =
  /** Move it to DONE THIS WEEK — finished, but still on the board to be swept. */
  | "park"
  /** Leave the canvas for the Archived view. Restorable. */
  | "archive"
  /** Remove it, with the usual undo window. */
  | "delete";

/**
 * The two-step exit for finished work: deleting a DONE card doesn't remove it,
 * it parks it in DONE THIS WEEK; deleting it again from there archives it.
 *
 * So the destructive step always needs a second, deliberate press, and the week's
 * finished work stays visible until you sweep it (nothing clears the group on a
 * timer — the section header's Bulk menu empties it in one go).
 *
 * A card that was never done is a different thing: it's junk you never started,
 * so it deletes on the first press as it always has. Parking it would put a
 * not-done card in a group called DONE THIS WEEK.
 *
 * @param tray the machine-managed group the card currently sits in, if any
 */
export function deletionOf(
  status: TaskStatus,
  tray: SystemGroup | null,
): DeleteAction {
  if (tray === "doneThisWeek") return "archive";
  return status === "done" ? "park" : "delete";
}

/** Stable id for a canvas's INBOX group. */
export const inboxGroupId = (canvasId: string): string =>
  systemGroupId("inbox", canvasId);

/** Stable id for one board's lane inside a canvas's INBOX group. */
export const inboxLaneId = (canvasId: string, boardId: string | null): string =>
  systemLaneId("inbox", canvasId, boardId);

/* ---------------------------- THIS WEEK ----------------------------
 * One `section_group` per canvas can be starred THIS WEEK (`data.thisWeek`),
 * naming the board an agent should drop work onto when it's for this week — or
 * when the agent is starting on it right now. Everything else stays unpinned and
 * shows up in INBOX.
 *
 * The star is the ONLY star: every section inside the flagged group is by that
 * fact its board's MASTER — the target of sibling sections' "Send to" button.
 * There used to be a second, independent `data.master` flag per section, which
 * meant a board's master could sit outside the THIS WEEK group and the two could
 * disagree about where this week's work goes. Now one flag answers both.
 *
 * Unlike the system groups above, this one is HAND-CURATED: the user makes it,
 * names it, and arranges its sections. The only machine part is materialising a
 * lane for a board the group doesn't cover yet (see `boardsNeedingWeekLane`), and
 * even then the lane is an ordinary section afterwards — renameable, movable,
 * deletable, and never auto-removed when it empties. */

/** The `data` flag marking the one group that is "this week". */
export const isThisWeekGroup = (n: Pick<CanvasNode, "kind" | "data">): boolean =>
  n.kind === "section_group" && n.data?.thisWeek === true;

/** The canvas's THIS WEEK group, or null. Ties break on node id so every client
 *  agrees even if two groups somehow carry the flag. */
export const thisWeekGroupId = (
  canvasNodes: readonly CanvasNode[],
): string | null => {
  const flagged = canvasNodes.filter(isThisWeekGroup).map((n) => n.id).sort();
  return flagged[0] ?? null;
};

/**
 * Stable id for one board's lane inside the THIS WEEK group.
 *
 * Derived for the same reason INBOX lane ids are — but here it also lets the
 * SERVER pin a task to a lane that doesn't exist yet. Canvas nodes live in
 * Liveblocks storage, so a row the server inserts is invisible to an open canvas
 * until storage re-hydrates; tasks, which poll, are not. So the server pins to
 * the id the lane WILL have and the canvas materialises it on the next poll
 * (`boardsNeedingWeekLane`), which makes the placement show up live.
 */
export const weekLaneId = (groupId: string, boardId: string | null): string =>
  `wk-${groupId}-${boardId ?? "noboard"}`;

/**
 * Each board's MASTER section: the lane it has inside the THIS WEEK group.
 * Empty when no group is starred — then no board has a master and no section
 * offers "Send to …", which is the honest answer rather than a stale one.
 *
 * Ties break on `position` then `id` — the same order as
 * `resolveThisWeekSection`'s `ORDER BY position, id`, so a group that somehow
 * holds two lanes for one board resolves identically on both tiers. Without
 * that, the server would file a task into one lane while the UI pointed at the
 * other.
 */
export const masterSectionsByBoard = (
  canvasNodes: readonly CanvasNode[],
): Map<string, CanvasNode> => {
  const groupId = thisWeekGroupId(canvasNodes);
  const byBoard = new Map<string, CanvasNode>();
  if (!groupId) return byBoard;
  const lanes = canvasNodes
    .filter((n) => n.kind === "section" && n.data?.groupId === groupId)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  for (const lane of lanes) {
    const bid = laneBoardId(lane);
    if (bid && !byBoard.has(bid)) byBoard.set(bid, lane);
  }
  return byBoard;
};

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

/**
 * Which boards need a lane materialised in the THIS WEEK group: those with a
 * task pinned to the lane's derived id (`weekLaneId`) where no such node exists.
 *
 * Only ever true for a pin the SERVER wrote, and only until the next reconcile:
 * when the group already covers a board, `resolveThisWeekSection` pins to that
 * existing section's real id instead, which never matches this pattern. A pin
 * whose board has since changed simply stops matching and the task falls back to
 * INBOX — the same rule as any pin that can't be resolved.
 */
export function boardsNeedingWeekLane(
  canvasNodes: readonly CanvasNode[],
  tasks: readonly PlaceableTask[],
  taskMap: Record<string, Task>,
): Set<string | null> {
  const groupId = thisWeekGroupId(canvasNodes);
  if (!groupId) return new Set();
  const nodeIds = new Set(canvasNodes.map((n) => n.id));
  const filed = boardsFiledInLanes(tasks, taskMap, (b) => weekLaneId(groupId, b));
  return new Set(
    [...filed].filter((b) => !nodeIds.has(weekLaneId(groupId, b))),
  );
}

/**
 * Which boards have work filed in a BACKLOG / LATER / DONE THIS WEEK group —
 * i.e. which lanes that group should have. The reconciler creates the ones that
 * are missing and drops the ones that aren't here, so a lane appears the moment
 * the first card lands in it and disappears once the last one leaves.
 *
 * Keyed on the canvas id rather than the group id (as `weekLaneId` is), because
 * a system group's id is itself derived from the canvas — which is what lets the
 * SERVER name a lane it can't see, knowing only which canvas it's on.
 *
 * INBOX is NOT resolved this way: nothing is ever pinned to an inbox lane, so
 * its demand comes from `boardsNeedingInbox` — the opposite question, "who is
 * unclaimed?".
 */
export function boardsFiledInSystemGroup(
  kind: SystemGroup,
  canvasId: string,
  tasks: readonly PlaceableTask[],
  taskMap: Record<string, Task>,
): Set<string | null> {
  return boardsFiledInLanes(tasks, taskMap, (b) =>
    systemLaneId(kind, canvasId, b),
  );
}

/** Shared body: boards whose tasks point at the lane id `laneIdFor` derives for
 *  them. A pin whose board has since changed simply stops matching, and the task
 *  falls back to INBOX — the same rule as any pin that can't be resolved. */
function boardsFiledInLanes(
  tasks: readonly PlaceableTask[],
  taskMap: Record<string, Task>,
  laneIdFor: (boardId: string | null) => string,
): Set<string | null> {
  const boards = new Set<string | null>();
  for (const t of tasks) {
    const pin = pinnedSectionId(taskMap[t.id]);
    if (pin && pin === laneIdFor(t.boardId)) boards.add(t.boardId);
  }
  return boards;
}
