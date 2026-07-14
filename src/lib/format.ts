/*
  Display-only formatting helpers. No business logic — just turning dates
  into calm, readable strings for the UI.
*/

/** ISO → "14:32" (24h local clock). */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** ISO → "Jun 27" short date. */
export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}

/** Whole calendar-ish days between `iso` and now (0 = today, ≥1 = past, <0 = future). */
export function daysAgo(iso: string, ref: number = Date.now()): number {
  return Math.floor((ref - new Date(iso).getTime()) / 86_400_000);
}

/** "today" / "1d" / "5d" — how long since `iso` (for time-in-status). */
export function formatAge(iso: string, ref: number = Date.now()): string {
  const d = daysAgo(iso, ref);
  return d <= 0 ? "today" : `${d}d`;
}

/** A friendly due-date label + whether it's overdue / due today. */
export function formatDue(
  iso: string,
  ref: number = Date.now(),
): { label: string; overdue: boolean; today: boolean } {
  const days = daysAgo(iso, ref);
  const today = days === 0;
  const overdue = days > 0;
  let label: string;
  if (today) label = "Today";
  else if (days === 1) label = "Yesterday";
  else if (days === -1) label = "Tomorrow";
  else label = formatShortDate(iso);
  return { label, overdue, today };
}

/** ISO → "5d ago" / "3h ago" / "just now", relative to a reference (default now). */
export function formatRelative(iso: string, ref: number = Date.now()): string {
  const diffMs = ref - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatShortDate(iso);
}
