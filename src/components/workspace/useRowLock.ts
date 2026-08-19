/**
 * Who holds an outline row — resolved from presence alone.
 *
 * A row is one task FIELD, and a field patch carries the whole value, so two
 * people typing in one row is the single case that cannot merge: last write wins
 * and somebody's characters vanish. Rather than warn after the fact, one editor
 * holds the row at a time.
 *
 * The lock IS presence: a claim is "my caret is in this row", so it dies with the
 * tab that made it — no server write on focus, no stale-lock recovery, and a
 * closed laptop releases it by itself.
 *
 * Two strengths, because most locks in practice are a caret somebody parked and
 * walked away from, and blocking on those is what makes locking hateful:
 *   • LIVE   — typed within `PARK_MS`. Genuinely read-only for everyone else.
 *   • PARKED — still in the row but idle. Shown, but the first keystroke takes it.
 *
 * Advisory, not a guarantee: Postgres stays last-writer-wins, and during a ~100ms
 * handover both clients can still type. This lowers the odds of a collision; it
 * does not make one impossible.
 */

/** Idle time after which an owner's claim stops blocking anyone. */
export const PARK_MS = 3000;

/** One person's claim on one field, flattened out of Liveblocks presence. */
export type RowClaim = {
  /** Liveblocks connection id — stable per tab, and the tie-break for `since`. */
  id: number;
  name: string;
  color: string;
  /** The field they are in (`<taskId>` or `<taskId>#desc`). */
  field: string;
  /** When they entered this row (their own clock — see the caveat below). */
  since: number;
  /** Their last keystroke. Separates a live lock from a parked one. */
  typingAt: number;
  /** A field this claimant is explicitly taking over, if any. */
  override?: string | null;
};

export type RowLock =
  /** Nobody is in this row. */
  | { state: "free" }
  /** We hold it. `waiting` is anyone else sitting in it — they are one keystroke
   *  (or one button) away from taking it, so the row says so. */
  | { state: "mine"; waiting: { name: string; color: string }[] }
  /** Someone else holds it. `live` false ⇒ parked: takeable by just typing. */
  | { state: "peer"; owner: { name: string; color: string }; live: boolean };

/**
 * Resolve one field's lock.
 *
 * Ownership: an explicit `override` wins (that's a deliberate takeover); failing
 * that, the earliest `since` wins, tie-broken on connection id.
 *
 * `since` is each client's own clock, so two claims landing inside the clock-skew
 * window can crown the wrong "first". Every client still computes the SAME owner
 * from the same numbers, so the answer is consistent everywhere —
 * consistent-but-occasionally-unfair, never divergent. A server timestamp would
 * remove the unfairness and isn't worth the round-trip.
 */
export function resolveRowLock(
  field: string | null,
  claims: readonly RowClaim[],
  myId: number,
  now: number,
): RowLock {
  if (!field) return { state: "free" };
  const here = claims.filter((c) => c.field === field);
  if (!here.length) return { state: "free" };

  const overriders = here.filter((c) => c.override === field);
  const pool = overriders.length ? overriders : here;
  // Among overriders the LATEST intent wins; otherwise the earliest claim does.
  const owner = pool.reduce((best, c) => {
    if (overriders.length) return c.since > best.since || (c.since === best.since && c.id < best.id) ? c : best;
    return c.since < best.since || (c.since === best.since && c.id < best.id) ? c : best;
  });

  if (owner.id === myId) {
    return {
      state: "mine",
      waiting: here.filter((c) => c.id !== myId).map((c) => ({ name: c.name, color: c.color })),
    };
  }
  return {
    state: "peer",
    owner: { name: owner.name, color: owner.color },
    live: now - owner.typingAt <= PARK_MS,
  };
}
