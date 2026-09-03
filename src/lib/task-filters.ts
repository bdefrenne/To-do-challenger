/**
 * WHO and WHICH BOARDS a view is showing — one rule, every surface (TD2-216).
 *
 * The canvas has had an assignee filter since TD-59; the project's List, Boards
 * and Done views and the canvas now share it, so "show me only Sam's work"
 * means the same thing wherever you turn it on. That's why the rule lives here
 * rather than in the view that happened to need it first.
 *
 * The rule in one line: **keep the branches that lead to a match, ancestors
 * included, and dim the ancestors kept only as context.** A match buried under
 * two parents would otherwise either vanish (filter the flat list) or drag in
 * its parents as if they were matches too.
 *
 * Every function here is a RENDER filter. Nothing it returns may be fed to a
 * writer that treats the set it was given as the whole world — see
 * `useOutlineDraft`, which is safe because it deletes only what someone deleted
 * by hand, and `CanvasEditor`'s lane reconciler, which is NOT (it sweeps any
 * lane whose board isn't in the set it reads, so a filtered board list must
 * never reach it).
 */

import type { TaskUnit } from "@/lib/outline";

/** The shape the filters need of a task: who it's assigned to, and where it
 *  lives. Structural, so a `Task`, a canvas unit's task and a done-log entry all
 *  satisfy it without this module depending on any of them. */
export interface Assigned {
  assigneeIds?: string[] | null;
  boardId?: string | null;
}

/** "Is this task itself one of the ones being shown?" — the direct test, before
 *  any ancestor-keeping. Everything in this module is built from one of these. */
export type TaskPredicate = (t: Assigned | undefined | null) => boolean;

/** Both filters as one predicate. `null` on either axis means "don't narrow on
 *  it"; `boardIds` null is ALL boards, which is not the same as the list of
 *  board ids that happen to exist today (see `useProjectFilters`). */
export function makeTaskPredicate({
  assigneeId = null,
  boardIds = null,
}: {
  assigneeId?: string | null;
  boardIds?: string[] | null;
}): TaskPredicate {
  if (!assigneeId && !boardIds) return () => true;
  const boards = boardIds ? new Set(boardIds) : null;
  return (t) => {
    if (!t) return false;
    if (assigneeId && !isAssignedTo(t, assigneeId)) return false;
    // A task on no board at all is hidden by any narrowing: it belongs to no
    // board, so no selection of boards can be said to include it.
    if (boards && !(t.boardId && boards.has(t.boardId))) return false;
    return true;
  };
}

/** Is this task itself assigned to them? The direct test — an ancestor kept for
 *  context fails it, which is exactly what dims it. */
export const isAssignedTo = (t: Assigned | undefined | null, assigneeId: string): boolean =>
  !!t?.assigneeIds?.includes(assigneeId);

/**
 * A filter as the CANVAS passes it around: the predicate, plus whether it's
 * narrowing anything at all.
 *
 * One object rather than an id and a board list threaded separately, because it
 * crosses four memo boundaries (CanvasEditor → CanvasNodeHost → CanvasNode →
 * SectionNode → TaskCard) that compare props by reference. Build it once, with
 * `useMemo`, and every one of those comparisons stays a pointer check.
 */
export interface RenderFilter {
  keep: TaskPredicate;
  /** The one person being shown, or null. Carried on the filter (rather than
   *  re-derived) because a COMPOSER needs it: a task created with nobody on it
   *  while a view shows one person's work would vanish as it was typed, so the
   *  composer offers to assign it to them (TD2-193). */
  assigneeId: string | null;
  /** Is this BOARD being drawn at all? The canvas asks it of a whole lane — a
   *  section bound to a board nobody selected isn't drawn, rather than drawn
   *  empty. `null` is the "No board" lane, which any narrowing hides for the
   *  same reason a board-less task is hidden. */
  showsBoard: (boardId: string | null) => boolean;
  /** True while something is being narrowed — what the "dim the context
   *  ancestors" and "don't mirror the shrunken height to storage" rules key off. */
  active: boolean;
}

/** Showing everything. A module constant so a component that is handed no
 *  filter compares equal to itself across renders. */
export const NO_FILTER: RenderFilter = {
  keep: () => true,
  assigneeId: null,
  showsBoard: () => true,
  active: false,
};

export function makeRenderFilter(opts: {
  assigneeId?: string | null;
  boardIds?: string[] | null;
}): RenderFilter {
  const active = !!opts.assigneeId || !!opts.boardIds;
  if (!active) return NO_FILTER;
  const boards = opts.boardIds ? new Set(opts.boardIds) : null;
  return {
    keep: makeTaskPredicate(opts),
    assigneeId: opts.assigneeId ?? null,
    showsBoard: (boardId) => !boards || (boardId !== null && boards.has(boardId)),
    active,
  };
}

/* ---------------------------------------------------------------- canvas units */

/** Does this unit, or any of its descendants, survive the filter? Used to decide
 *  whether a unit stays at all — a match buried a few levels deep keeps its
 *  ancestors around too, so the tree isn't left with orphaned children. */
export function unitMatches(unit: TaskUnit, keep: TaskPredicate): boolean {
  if (keep(unit.task)) return true;
  return unit.children.some((c) => unitMatches(c, keep));
}

/** Prune a unit tree down to branches that lead to a match. An ancestor kept
 *  only because a descendant matches stays in the tree — the card renderer dims
 *  it so it reads as context, not as a hidden match. A predicate that keeps
 *  everything hands the tree straight back. */
export function filterUnits(units: TaskUnit[], keep: TaskPredicate): TaskUnit[] {
  const kept = units.filter((u) => unitMatches(u, keep));
  const out = kept.map((u) => {
    const children = filterUnits(u.children, keep);
    // Nothing pruned below ⇒ hand back the SAME unit. `useSectionUnits` works
    // hard to keep unit identity stable so cards can memoize; rebuilding every
    // unit here would throw that away the moment a filter was on (TD-132).
    return children === u.children ? u : { ...u, children };
  });
  return out.every((u, i) => u === units[i]) && out.length === units.length
    ? units
    : out;
}

/* ------------------------------------------------------------- workspace nodes */

/** The project views hold tasks as flat NODES plus a children lookup, not as a
 *  tree — so the same rule arrives as a predicate over ids instead of a prune.
 *  `taskOf` is the node → task lookup (a node carries no assignees of its own). */
export interface NodeMatcherInput<N extends { id: string }> {
  keep: TaskPredicate;
  taskOf: (id: string) => Assigned | undefined;
  childrenOf: (id: string) => N[];
}

/**
 * "Should this node be drawn at all?" — true when it or any descendant matches.
 *
 * MEMOIZED per call to this factory: a list draws a parent and then asks the
 * same question of each of its children, so an un-cached recursion re-walks
 * every subtree once per level. Cycle-safe (a corrupt parent chain would
 * otherwise recurse forever), which the tree-shaped `unitMatches` gets for free
 * and this does not.
 *
 * With a keep-everything predicate every node matches, so callers can use it
 * unconditionally.
 */
export function makeNodeMatcher<N extends { id: string }>({
  keep,
  taskOf,
  childrenOf,
}: NodeMatcherInput<N>): (id: string) => boolean {
  const cache = new Map<string, boolean>();
  const walk = (id: string, seen: Set<string>): boolean => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    if (seen.has(id)) return false; // corrupt parent cycle — not a match
    seen.add(id);
    const self = keep(taskOf(id));
    const out = self || childrenOf(id).some((c) => walk(c.id, seen));
    seen.delete(id);
    cache.set(id, out);
    return out;
  };
  return (id) => walk(id, new Set());
}
