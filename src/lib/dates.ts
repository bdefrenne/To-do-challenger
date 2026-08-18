/*
  Local-time calendar arithmetic, shared by the views that lay days out in a
  grid (the Calendar, the Done view).

  These are deliberately LOCAL-time and date-only: a calendar cell is a day in
  the reader's own zone, and constructing dates through the y/m/d constructor
  keeps every result at local midnight, so no result can drift across a DST
  boundary the way `setDate` on a UTC-parsed instant does.

  Server-side windowing is a different problem with a different tool: see
  `dateWindow` / `dayIn` in `db/service.ts`, which resolve an explicit IANA zone
  rather than the reader's.
*/

/** Monday of the week containing `d`, at local midnight. */
export function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const mondayOffset = (x.getDay() + 6) % 7; // Sun=0 → 6, Mon=1 → 0, …
  x.setDate(x.getDate() - mondayOffset);
  return x;
}

/** `d` shifted by `n` days, at local midnight. */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Local `YYYY-MM-DD` — the key both views bucket on. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` → local midnight. The inverse of `ymd`. */
export function fromYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
