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

import type { CanvasNode, Task, TaskPlacement, TaskStatus } from "./types";

/* --------------------------- System groups ---------------------------
 * Three groups on every canvas are MACHINE-MANAGED: the editor creates them,
 * names them, and keeps one lane per board inside each. They're the triage
 * destinations — where a card goes when it isn't scheduled:
 *
 *   INBOX           untriaged. The odd one out: its lanes mean "unpinned", so a
 *                   task lands here by having no pin at all (`isInboxNode`).
 *   TODAY           on today's shortlist — the daily counterpart to THIS WEEK.
 *                   Machine-managed rather than hand-starred, so it exists on
 *                   every canvas and agents can file into it without the user
 *                   having made a group first. A real pin.
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
export type SystemGroup =
  | "inbox"
  | "today"
  | "thisWeek"
  | "backlog"
  | "later"
  | "doneThisWeek";

/** The five kinds in display order — also the order they're stacked down the
 *  left of a canvas: what's arriving, what's on today's list, what's parked,
 *  what's finished. */
export const SYSTEM_GROUPS: readonly SystemGroup[] = [
  "inbox",
  "today",
  "thisWeek",
  "backlog",
  "later",
  "doneThisWeek",
];

/** Header text for each system group's container. */
export const SYSTEM_GROUP_TITLE: Record<SystemGroup, string> = {
  inbox: "INBOX",
  today: "TODAY",
  thisWeek: "THIS WEEK",
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
  /** Mark it done, then park it — DELETE on a card that's in REVIEW accepts it. */
  | "complete"
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
 * A card in REVIEW is finished work waiting to be accepted, so DELETE means
 * "accept it": it's marked done and parked in the same one press. The archiving
 * second press then works exactly as it does for a card that was already done.
 *
 * A card that was never done is a different thing: it's junk you never started,
 * so it deletes on the first press as it always has. Parking it would put a
 * not-done card in a group called DONE THIS WEEK.
 *
 * The two steps still hold where there IS a tray to park in. On the canvas there
 * isn't one (TD-87), so the pair becomes REVIEW → done-in-place → archived: the
 * card stays in its own board's lane, visibly finished, until a second press
 * takes it off the board. Same shape, one fewer place for it to go.
 *
 * @param tray the machine-managed group the card currently sits in, if any
 * @param opts.canPark whether the calling surface HAS a DONE THIS WEEK tray to
 *   park into. Defaults true; the canvas passes false.
 */
/** The machine-managed tray a placement bucket corresponds to. Every bucket now
 *  has one — THIS WEEK used to be the exception, the one group a user made and
 *  starred by hand (TD-137). Kept as a named function rather than inlined: it's
 *  the seam where the two vocabularies (`TaskPlacement`, `SystemGroup`) meet,
 *  and it's what lets a view that renders by bucket answer `deletionOf`'s
 *  `tray` question without a canvas to ask. */
export const trayOfPlacement = (p: TaskPlacement): SystemGroup | null => p;

export function deletionOf(
  status: TaskStatus,
  tray: SystemGroup | null,
  opts?: { canPark?: boolean },
): DeleteAction {
  if (tray === "doneThisWeek") return "archive";
  if (status === "review") return "complete";
  if (status !== "done") return "delete";
  // Nowhere to park — the canvas has no DONE THIS WEEK tray, so a done card
  // just sits in its board's lane wearing the green wash until it's archived,
  // and DELETE is what archives it. Still not silent: the usual undo window
  // applies, and archiving is reversible from the Archived view.
  return opts?.canPark === false ? "archive" : "park";
}

/** Stable id for a canvas's INBOX group. */
export const inboxGroupId = (canvasId: string): string =>
  systemGroupId("inbox", canvasId);

/** Stable id for one board's lane inside a canvas's INBOX group. */
export const inboxLaneId = (canvasId: string, boardId: string | null): string =>
  systemLaneId("inbox", canvasId, boardId);

/* ---------------------------- THIS WEEK ----------------------------
 * THIS WEEK is where an agent drops work that's for this week — or that it's
 * starting on right now. Everything else stays unpinned and shows up in INBOX.
 *
 * It is an ORDINARY SYSTEM GROUP (TD-137). It used to be the one exception: a
 * group the user made, named, and starred, found by its `data.thisWeek` flag,
 * with lanes under a `wk-<groupId>-<boardId>` scheme of their own. That
 * exception is where its whole failure class came from — being hand-made, it
 * could be deleted, could simply not exist until a pin happened to materialise
 * it, left its lanes orphaned when it went, and had its position set once at
 * creation with nothing to correct it.
 *
 * Now the reconciler owns it like any other tray: derived id
 * (`systemGroupId("thisWeek", canvasId)`), derived lanes
 * (`systemLaneId("thisWeek", …)`), created and repaired automatically.
 *
 * What survives from the hand-made era, because it was the good part: a section
 * you make yourself inside the group is still an ordinary section — renameable,
 * movable, and PREFERRED over a derived lane by `resolvePlacementSection`, so
 * your own "Platform"/"Racing" lanes stay the thing work lands in. The
 * reconciler only ever creates and removes lanes carrying the `data.thisWeek`
 * flag, so it can't touch them.
 *
 * Each board's lane here is by that fact its board's MASTER — the target of
 * sibling sections' "Send to" button. That used to be what the star meant; it's
 * now simply what being the THIS WEEK lane means, which is the same rule with
 * nothing left to set by hand. */

/**
 * Each board's MASTER section: the lane it has inside the THIS WEEK group.
 *
 * Ties break on `position` then `id` — the same order as
 * `resolvePlacementSection`'s `ORDER BY position, id`, so a group that somehow
 * holds two lanes for one board resolves identically on both tiers. Without
 * that, the server would file a task into one lane while the UI pointed at the
 * other.
 */
export const masterSectionsByBoard = (
  canvasNodes: readonly CanvasNode[],
  canvasId: string,
): Map<string, CanvasNode> => {
  const groupId = systemGroupId("thisWeek", canvasId);
  const byBoard = new Map<string, CanvasNode>();
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
 * A lane id from the era when THIS WEEK was hand-made: `wk-<groupId>-<boardId>`.
 *
 * Kept ONLY so old pins keep reading as THIS WEEK (`placementOfDerivedId`) and
 * so the reconciler can recognise and sweep the superseded nodes. Nothing writes
 * this shape any more — new lanes are `systemLaneId("thisWeek", …)`. Pins are
 * rewritten by `scripts/repair-week-lane-ids.ts`.
 */
export const LEGACY_WEEK_LANE_PREFIX = "wk-";

/**
 * The ids of the trays arranged around THIS WEEK — TODAY above, INBOX to THIS
 * WEEK's left, BACKLOG and LATER below — which travel together as one rigid unit
 * on the canvas.
 * Grabbing any one of them drags the others along, preserving whatever relative
 * offset they currently sit at (see `onNodePointerDown` in CanvasEditor).
 *
 * Purely a MOVEMENT grouping, layered on top of ordinary system-group identity:
 * it doesn't change membership, pinning, or the reconciler. It exists so the
 * arrangement the anchor effect maintains survives a drag — moving one tray out
 * from under the others would just be undone on the next render.
 *
 * Only ids that actually exist on this canvas come back, so it degrades
 * gracefully: a tray not materialised yet simply doesn't travel.
 */
/**
 * Has a human placed this group by hand?
 *
 * Auto-placement is a convenience for an ORDINARY group nobody has touched. The
 * moment someone drags one, that position is the answer and nothing may
 * recompute it: a layout you arranged and that silently springs back is worse
 * than no layout at all.
 *
 * NOT for the machine-managed trays any more (TD2-171). Their positions are all
 * derived from one stored origin — the head tray's own x/y — and a drag moves
 * the whole column rigidly, so your hand already IS the stored truth and there
 * is nothing to opt out of. A per-tray flag there was actively harmful: a
 * flagged tray stopped being arranged while `computeGroupLayout` went on growing
 * its box, so it grew straight through its neighbour's frame.
 *
 * The flag lives in Liveblocks storage alongside x/y, so it is SHARED — one
 * arrangement everyone sees, not a per-viewer preference.
 */
export const isPinnedGroup = (n: Pick<CanvasNode, "data">): boolean =>
  n.data?.placed === true;

/** Keys a TRAY may carry that no longer mean anything: `pinned` from the
 *  every-group-in-the-drag rule, `anchoredToWeek` from an opt-in anchor that was
 *  deleted years of commits ago and read nowhere, and `placed` from when a tray
 *  could opt out of the arrangement — left on, it's what lets a tray overlap its
 *  neighbour (TD2-171). Swept from the trays only: `placed` still means what it
 *  says on a group you made yourself. */
export const DEAD_GROUP_KEYS = ["pinned", "anchoredToWeek", "placed"] as const;

export function anchoredTrayGroupIds(
  canvasNodes: readonly CanvasNode[],
  canvasId: string,
): Set<string> {
  const existing = new Set(canvasNodes.map((n) => n.id));
  const ids = [
    systemGroupId("thisWeek", canvasId),
    systemGroupId("today", canvasId),
    systemGroupId("inbox", canvasId),
    systemGroupId("backlog", canvasId),
    systemGroupId("later", canvasId),
  ].filter((id): id is string => id !== null && existing.has(id));
  return new Set(ids);
}

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
/**
 * "This task belongs on no canvas section, and that is the correct answer" —
 * as opposed to `null`, which means "nothing claims it, so INBOX should".
 *
 * Only DONE THIS WEEK produces it today. A NUL prefix so it can never collide
 * with a real node id (uuids and the derived `<kind>-<uuid>-<uuid>` shapes).
 */
const OFF_CANVAS = "\u0000off-canvas";

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
    // A DONE THIS WEEK pin means "off the canvas on purpose". It must short-
    // circuit BEFORE the fall-through below, or the missing lane would read as
    // "unplaced" and the INBOX reconciler would draw a lane to hold it —
    // finished work coming back as untriaged. Checked on the id rather than on
    // whether the node exists, so it holds both before and after the tray is
    // swept from storage.
    if (pin && placementOfDerivedId(pin) === "doneThisWeek") {
      memo.set(id, OFF_CANVAS);
      return OFF_CANVAS;
    }

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
    // Deliberately off-canvas: not a member of anything, and NOT unplaced —
    // `unplaced` is what INBOX lanes get built from.
    if (sectionId === OFF_CANVAS) continue;
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

/* ------------------- Placement OFF the canvas -------------------
 * `buildSectionMembership` above answers "which Section shows this card?", which
 * only a mounted canvas can ask — it needs every node. The board views need the
 * coarser question, "which BUCKET is this card in?", and they have no canvas.
 *
 * So the canvas is flattened once, server-side, into a section id → placement
 * map (`PlacementMap`, built by `listPlacementSections`) and the lookup below
 * reads a task against it. Same answer as the canvas gives, three orders of
 * magnitude less data than shipping the nodes. */

/** Section node id → the bucket that section belongs to. Sections that aren't in
 *  any bucket (a user's own group out on the canvas) are simply absent. */
export type PlacementMap = Record<string, TaskPlacement>;

/** Display order of the buckets in the board views — the triage ladder read top
 *  to bottom: what's unsorted, what just finished, what's on today, this week,
 *  and what's parked. */
export const PLACEMENT_ORDER: readonly TaskPlacement[] = [
  "inbox",
  "doneThisWeek",
  "today",
  "thisWeek",
  "backlog",
  "later",
];

/** Header text for each bucket. The system groups already name themselves; THIS
 *  WEEK is hand-made, so it isn't in that map.
 *
 *  These are the DEFAULTS — the names a freshly reconciled canvas gives its
 *  groups. A group can be renamed on the canvas, so the board views prefer the
 *  live name (`PlacementTitles`, below) and fall back to these. */
export const PLACEMENT_TITLE: Record<TaskPlacement, string> = {
  ...SYSTEM_GROUP_TITLE,
  thisWeek: "THIS WEEK",
};

/**
 * The name each bucket's group actually carries ON THE CANVAS, for the buckets
 * that have a group drawn. Partial because a bucket can legitimately have none:
 * the trays are materialised on demand, and THIS WEEK only exists once someone
 * stars a group.
 *
 * Shipped alongside the placement map (`listPlacementGroups`) because a renamed
 * group would otherwise make the two surfaces disagree about the SAME bucket —
 * rename the tray to "Parked" on the canvas and the board view would still head
 * that band "LATER", which reads as a different bucket rather than the one you
 * just renamed.
 */
export type PlacementTitles = Partial<Record<TaskPlacement, string>>;

/** What to head a bucket's band with: its canvas name, else the default. Blank
 *  names fall through too — an unnamed group on the canvas shows its default
 *  label there, so it must show the same one here. */
export const placementTitle = (
  titles: PlacementTitles | undefined,
  placement: TaskPlacement,
): string => titles?.[placement]?.trim() || PLACEMENT_TITLE[placement];

/**
 * The gradient behind a bucket's separator bar — a full-width band with white
 * text, so the separators CUT the page rather than sitting in it.
 *
 * The ramp carries the ladder's meaning, warm → cool → grey: TODAY is a sunrise
 * because it's the only bucket that means *now*, THIS WEEK cools through blue to
 * indigo, DONE THIS WEEK settles into the same green the finished cards use, and
 * everything unscheduled greys out, fading further the further out it is.
 *
 * Each runs left→right from its DARKEST stop, which is where the label sits — so
 * the white text keeps its contrast even on the pale end of the grey ramp, and
 * the bar lightens as it runs out toward the empty right edge.
 *
 * Deliberately NOT the status palette: a bar and a status pill sitting on the
 * same screen must not look like they're saying the same thing.
 */
export const PLACEMENT_BAR: Record<TaskPlacement, string> = {
  inbox: "bg-linear-to-r from-slate-700 via-slate-600 to-slate-400",
  doneThisWeek: "bg-linear-to-r from-emerald-700 via-emerald-600 to-teal-400",
  today: "bg-linear-to-r from-rose-600 via-orange-500 to-amber-400",
  thisWeek: "bg-linear-to-r from-indigo-700 via-blue-600 to-sky-400",
  backlog: "bg-linear-to-r from-slate-600 via-slate-500 to-slate-300",
  later: "bg-linear-to-r from-slate-500 via-slate-400 to-slate-200",
};

/**
 * The bucket a section id names, WITHOUT consulting the canvas.
 *
 * Covers the case the map can't: a pin the server wrote to a lane that doesn't
 * exist yet. `resolvePlacementSection` deliberately returns a DERIVED id
 * (`weekLaneId` / `systemLaneId`) for a board the group doesn't cover, leaving
 * the canvas to materialise the node on its next reconcile — so between the
 * write and that reconcile there is no node to look up. Reading the id itself
 * is what stops a just-filed task from showing in INBOX for those few seconds.
 *
 * Prefix-matching is safe because both id shapes are `<kind>-<uuid>-<uuid>`: a
 * real section id is a bare uuid, which starts with none of these.
 */
export function placementOfDerivedId(
  sectionId: string,
): TaskPlacement | null {
  // Legacy: THIS WEEK lanes were `wk-<groupId>-<boardId>` while the group was
  // hand-made (TD-137). Nothing writes the shape now, but old pins still carry
  // it and must keep bucketing correctly until they're rewritten.
  if (sectionId.startsWith(LEGACY_WEEK_LANE_PREFIX)) return "thisWeek";
  for (const kind of SYSTEM_GROUPS)
    if (sectionId.startsWith(`${kind}-`)) return kind;
  return null;
}

/**
 * Which bucket a task sits in: its own pin, else whatever its parent resolves to
 * (an unpinned subtask inherits its parent's placement, exactly as it does on
 * the canvas), else INBOX — which IS the absence of a pin.
 *
 * A pin we can't place — a section on someone's canvas that isn't in any bucket,
 * or a node that's been deleted — reads as INBOX rather than vanishing, on the
 * same principle as the canvas's own "a pin that can't be resolved falls back to
 * INBOX": a card that's filed somewhere the view can't show must still be
 * somewhere the view CAN show.
 *
 * `parentOf` is passed in rather than read off the task because `Task` has no
 * parent link — nesting lives on the tree node (`TaskNode.parentId`), which is
 * what every caller already has to hand.
 */
export function placementOfTask(
  taskId: string,
  taskMap: Record<string, Task>,
  parentOf: (id: string) => string | null,
  map: PlacementMap,
): TaskPlacement {
  const seen = new Set<string>();
  let id: string | null = taskId;
  // `seen` guards a corrupt parent cycle, same as buildSectionMembership.
  while (id && !seen.has(id)) {
    seen.add(id);
    const pin = pinnedSectionId(taskMap[id]);
    if (pin) return map[pin] ?? placementOfDerivedId(pin) ?? "inbox";
    id = parentOf(id);
  }
  return "inbox";
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
 * Which boards have work filed in a system group (THIS WEEK / BACKLOG / LATER /
 * DONE THIS WEEK) —
 * i.e. which lanes that group should have. The reconciler creates the ones that
 * are missing and drops the ones that aren't here, so a lane appears the moment
 * the first card lands in it and disappears once the last one leaves.
 *
 * Keyed on the CANVAS id: a system group's id is itself derived from the canvas,
 * which is what lets the SERVER name a lane it can't see, knowing only which
 * canvas it's on.
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
