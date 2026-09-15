/**
 * What a "Clear Done" sweep ACTS ON — the one rule, shared by the two buttons
 * that offer it (TD2-218).
 *
 * There are two sweeps and they must agree, because they clear the same cards
 * from different angles: a board column's own button (`BoardsColumns`, bounded
 * by one band × one board and by whatever the view is filtering), and the
 * project header's (`ClearDoneButton`, the whole project at once, filters
 * deliberately ignored — a sweep you reach for to empty the project must not
 * quietly skip the boards someone's filter is hiding). Scope is the caller's to
 * state; what's left is the part that's easy to get quietly wrong, and it lives
 * here.
 *
 * THE PART THAT IS EASY TO GET WRONG: a done card whose done PARENT is being
 * swept too. If it has no pin of its own it renders where it does by inheriting
 * its parent's placement (`placementOfTask` walks up), so it follows the parent
 * for free — and naming it as well would convert that inherited placement into a
 * hand-made one, so the next time the parent moved, the child would stay behind.
 * But if it HAS a pin, nothing carries it: the parent's move leaves it exactly
 * where it is. So the pinned child must be named, and the unpinned one must not.
 * Getting this backwards doesn't render oddly — it leaves finished work behind
 * in a band you just cleared, or welds a subtask to a lane it was never filed
 * into.
 *
 * Pure: no React, no fetch, no clock. Proven by `npm run check:sweep`.
 */

import type { TaskStatus } from "./types";

/** The shape a sweep needs of a task — `TaskNode` satisfies it. */
export interface SweepNode {
  id: string;
  parentId: string | null;
  boardId: string | null;
  status: TaskStatus;
}

export function sweepableDoneIds<N extends SweepNode>(
  nodes: readonly N[],
  opts: {
    /** The caller's scope: band, board, filters, "not already in the tray" —
     *  everything about WHERE, which differs between the two sweeps. */
    inScope: (node: N) => boolean;
    /** Does this card carry a pin of its own? An unpinned one inherits, and so
     *  rides along with a swept parent instead of being named. */
    pinned: (id: string) => boolean;
  },
): string[] {
  const candidates: N[] = [];
  const sweeping = new Set<string>();
  for (const node of nodes) {
    if (node.status !== "done" || !opts.inScope(node)) continue;
    candidates.push(node);
    sweeping.add(node.id);
  }
  return candidates
    .filter(
      (node) =>
        !(
          node.parentId &&
          sweeping.has(node.parentId) &&
          // Only an INHERITED placement rides along; see the doc above.
          !opts.pinned(node.id)
        ),
    )
    .map((node) => node.id);
}
