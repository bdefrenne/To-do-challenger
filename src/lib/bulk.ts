/**
 * The `/api/tasks/bulk` contract — the parts BOTH sides need.
 *
 * Deliberately its own module with no imports: the service layer defines the
 * behaviour, but the browser has to know the per-batch cap (to chunk below it)
 * and the per-op result shape (to see which ops failed). Reaching into
 * `db/service` from a `"use client"` file to get them would drag the Neon client
 * and the blob SDK into the browser bundle.
 */

/**
 * Hard cap on how many ops one `bulkApply` batch runs.
 *
 * Ops beyond it are DROPPED, and they get no `results` entry — so a caller that
 * only counts results can't tell. `truncated: true` is the only signal. Clients
 * should chunk to this size rather than rely on that flag (see the workspace
 * `bulk` helper).
 */
export const MAX_BULK_OPS = 200;

/** Outcome of a single op — so a partial failure is visible, not silent.
 *  Positionally aligned with the `operations` array that produced it. */
export interface OpResult {
  op: "create" | "update" | "move" | "complete" | "comment" | "delete";
  ok: boolean;
  /** The affected task id (the new id for a successful `create`). */
  id?: string;
  /** Present when `ok` is false. */
  error?: string;
}
