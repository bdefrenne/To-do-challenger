/**
 * The order tasks are listed in — one rule, shared by every surface.
 *
 * `position` alone does NOT determine an order. It's handed out per
 * **(status, parentId)** group (see `nextPosition`) and never renumbered when a
 * task changes status, so any view that mixes statuses — a canvas Section, an
 * INBOX lane — routinely holds several tasks with the SAME position. Sorting on
 * position alone leaves those ties to be broken by whatever order the rows
 * arrived in, which for a `Seq Scan → Sort` is unspecified and shifts as the
 * table changes: deleting one card would re-permute cards nobody touched.
 *
 * So the order is made **total** — `position`, then `createdAt`, then `id`.
 * Fully determined by the rows themselves, and therefore identical on every
 * client, on every fetch, before and after a delete.
 *
 * **This must stay in lockstep with the SQL `ORDER BY` in `db/service.ts`.**
 * Both sides sort the same lists, and the canvas drop math reads a card's
 * neighbours off the sorted array — if they disagree, a card dropped between
 * two others is positioned against different neighbours than the user saw.
 */

/** The minimum needed to order two tasks. Satisfied by both `TaskNode` (client)
 *  and the task DTO/row (server). */
export interface OrderableTask {
  id: string;
  position: number;
  createdAt: string; // ISO
}

/** Compare two tasks by the canonical order. Use as an `Array.sort` comparator. */
export const compareTaskOrder = (a: OrderableTask, b: OrderableTask): number =>
  a.position - b.position ||
  (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * `orderedIds` with `dragId` pulled out and re-inserted before/after `targetId`
 * — the desired order after a drop, as an explicit sequence.
 *
 * Reorders are expressed as a SEQUENCE and then restamped densely
 * (`position: i`) rather than interpolated into a gap. Interpolating can't work
 * here: `position` is minted per (status, parent) and never renumbered, so a run
 * routinely holds ties, and the midpoint of two equal positions IS that
 * position — the card would settle by tiebreak instead of where it was dropped.
 * (Repeated halving also decays toward the limits of double precision.) The same
 * restamping is what the section outline editor and `sendToMaster` already do.
 *
 * Pass the run **as rendered** — `compareTaskOrder` order, over exactly the
 * cards the user can see. Reordering any other list moves the card relative to
 * neighbours that weren't on screen.
 *
 * A `targetId` that isn't in the run appends instead: membership is derived, so
 * the two can legitimately disagree, and landing at the end is recoverable where
 * landing at an arbitrary index is not. A card dropped on ITSELF doesn't move —
 * callers already guard that, but the sequence has to say so too, or removing
 * the drag and failing to find the target would append it.
 */
export function insertRelative(
  orderedIds: readonly string[],
  dragId: string,
  targetId: string,
  pos: "before" | "after",
): string[] {
  if (dragId === targetId) return [...orderedIds];
  const without = orderedIds.filter((id) => id !== dragId);
  const ti = without.indexOf(targetId);
  const at = ti === -1 ? without.length : pos === "before" ? ti : ti + 1;
  return [...without.slice(0, at), dragId, ...without.slice(at)];
}
