/*
  THE WORKING DAY — which day a moment of work belongs to.

  Every "what happened on day X" read in the app funnels through here: the Done
  view's columns, the standup digest's window, and the work-day close-out. It is
  pure (no DB, no request) so the server, the UI and the check scripts can all
  agree on one answer.

  Two ideas, deliberately separate:

    1. **The reader's zone, not UTC.** A task finished at 00:30 in Brussels is not
       "yesterday" because UTC says 23:30. Callers pass an explicit IANA zone.

    2. **A working day starts at `DAY_BOUNDARY_HOUR`, not midnight.** Work at
       01:00 is the end of a long evening, not the start of a new day, and filing
       it under the new date puts it in a standup that hadn't happened yet and
       strips it out of the one that had. So the day boundary sits in the small
       hours, where nobody is working.

  Idea 2 is what makes `workingDayOf` differ from a plain calendar date; idea 1
  is why it can't be done with local-midnight arithmetic (see `dates.ts`, which
  is the client-side calendar-grid counterpart and stays midnight-based).

  `workingDayStart` and `workingDayOf` MUST stay exact inverses. A row's day and
  a window edge that disagree about where a boundary belongs is the bug class
  this module exists to prevent: an event would be listed under a day the window
  for that day excludes, so it would vanish from both.
*/

/**
 * The local hour a working day begins. 04:00 — late enough that a midnight
 * finish still counts as the previous day's work, early enough that nobody has
 * started the next day's.
 *
 * Changing this re-buckets historical rows (they carry instants, not days), so
 * a past standup would be recomputed. That's intended for a one-off correction
 * and a good reason not to fiddle with it.
 */
export const DAY_BOUNDARY_HOUR = 4;

const BOUNDARY_MS = DAY_BOUNDARY_HOUR * 60 * 60 * 1000;

/**
 * The zone every day is resolved in when a caller doesn't name one.
 *
 * A FIXED zone, not a per-user setting, because this is a single-team tool and
 * one shared answer is simpler than seven. The alternative was a `timezone`
 * column on `users`, which buys nothing while everyone works in one place.
 *
 * It has to be a real zone rather than UTC. Server-side readers have no browser
 * to ask — the MCP `standup` tool and `standup_report` prompt pass no zone at
 * all — so a UTC default combined with `DAY_BOUNDARY_HOUR` would put their day
 * boundary at 04:00 UTC, which is 06:00 here: work done before 6am would be
 * credited to the previous day. Defaulting to the zone people actually work in
 * is what makes the boundary mean what it says on every surface.
 *
 * If the team ever spans zones, this is the single place that has to change —
 * into a lookup on the acting user, resolved at the same auth boundary that
 * already supplies actor and surface (`db/log-context.ts`). Every caller here
 * takes `tz` as a parameter already, so nothing else would move.
 */
export const APP_TIMEZONE = "Europe/Brussels";

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Is this a bare `YYYY-MM-DD` (a whole day) rather than an ISO instant? */
export const isDayOnly = (s: string): boolean => DAY_ONLY.test(s);

/** How far `tz` is ahead of UTC at a given instant, in ms (0 for UTC). */
export function tzOffsetMs(at: Date, tz: string): number {
  if (tz === "UTC") return 0;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // hour12:false renders midnight as "24" on some ICU builds — fold it back.
  const asIfUtc = Date.UTC(
    n("year"),
    n("month") - 1,
    n("day"),
    n("hour") % 24,
    n("minute"),
    n("second"),
  );
  return asIfUtc - at.getTime();
}

/**
 * The instant at which working day `YYYY-MM-DD` (+ `plusDays`) begins in `tz` —
 * i.e. `DAY_BOUNDARY_HOUR` local time on that date.
 *
 * The boundary hour goes into the naive UTC value rather than being added
 * afterwards, so the DST correction below resolves "04:00 local" itself. Adding
 * four hours to a corrected midnight would be an hour out on a night the clocks
 * move, which is exactly the seam where a missed event is hardest to notice.
 */
export function workingDayStart(day: string, tz: string, plusDays = 0): Date {
  const [y, m, d] = day.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d + plusDays, DAY_BOUNDARY_HOUR);
  // The offset sampled at the naive instant is right except when the edge sits
  // across a DST change; one correction lands it (offsets shift by an hour, day
  // boundaries are 24 apart).
  const off = tzOffsetMs(new Date(naive), tz);
  const first = naive - off;
  return new Date(first - (tzOffsetMs(new Date(first), tz) - off));
}

/**
 * The working day `at` falls on in `tz` — the inverse of `workingDayStart`, and
 * the day the Done view buckets on.
 *
 * Shifting back by the boundary before taking the date is what moves a 01:00
 * finish onto the previous day: local 01:00 minus four hours is 21:00 the day
 * before, whose date is the working day we want.
 */
export function workingDayOf(at: Date, tz: string): string {
  const shifted = at.getTime() + tzOffsetMs(at, tz) - BOUNDARY_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** The working day happening right now. The one place "today" is decided, so a
 *  guard, a view and a query can't disagree about which day it is at 01:00. */
export function currentWorkingDay(tz = APP_TIMEZONE): string {
  return workingDayOf(new Date(), tz);
}

/**
 * Parse a caller's date window into a HALF-OPEN instant range `[start, end)`.
 *
 * Both ends are optional and accept either a bare day (`YYYY-MM-DD`) or a full
 * ISO instant. A bare day means the whole WORKING day in `tz`, so
 * `from = to = "2026-08-04"` covers 04T04:00 → 05T04:00 — "what happened on the
 * 4th?", as a person who worked that day would mean it.
 *
 * `end` is EXCLUSIVE: compare with `< end`, never `<=`. That way an event a
 * millisecond before the boundary counts and one at the boundary does not, and
 * consecutive windows tile without double-counting.
 */
export function dateWindow(
  from?: string,
  to?: string,
  tz = APP_TIMEZONE,
): { start?: Date; end?: Date } {
  return {
    start: from
      ? isDayOnly(from)
        ? workingDayStart(from, tz)
        : new Date(from)
      : undefined,
    end: to
      ? isDayOnly(to)
        ? workingDayStart(to, tz, 1)
        : new Date(to)
      : undefined,
  };
}
