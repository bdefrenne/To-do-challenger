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

/* ---- Markdown → a one-line teaser --------------------------------------
   The Done view heads each person's column with the standup they wrote, and
   the closed state has room for about a line and a half. Rendering the markdown
   and clamping it with CSS doesn't work: a standup written to the Finish work
   prompt starts with a SECTION HEADING ("Progress / Blockers / Questions / To
   review"), so a three-line clamp of the rendered form spends all three lines on
   one bold word and shows none of the content.

   So the teaser is built from the source text instead, and rendered as a plain
   string. Two consequences worth having: no `line-clamp` over block children
   (fragile — it needs the clamped box to hold inline content), and the prose
   itself never has to leave Postgres for a list read (PLAT-403). */

/** Rough inline/block markdown syntax, stripped in order. Deliberately regex and
 *  not a remark round-trip: this feeds a teaser, and a parser would be both
 *  heavier and no more correct at "what does this say, roughly". */
const STRIP: [RegExp, string][] = [
  // Fenced blocks go entirely — a code sample says nothing about a day.
  [/```[\s\S]*?```/g, " "],
  [/~~~[\s\S]*?~~~/g, " "],
  // Images before links: `![alt](src)` would otherwise leave a stray "!".
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]*)\]\([^)]*\)/g, "$1"],
  // Line-leading furniture: heading hashes, quote marks, list bullets, numbers.
  [/^[ \t]*#{1,6}[ \t]+/gm, ""],
  [/^[ \t]*>[ \t]?/gm, ""],
  [/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, ""],
  // A `---` rule contributes nothing once the lines around it are joined.
  [/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ""],
  // Emphasis and inline code, marker by marker.
  [/(\*\*|__|~~)(.*?)\1/g, "$2"],
  [/(?<![\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, "$1"],
  [/`([^`]*)`/g, "$1"],
  // Table pipes: keep the cells, drop the grid.
  [/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, ""],
  [/[ \t]*\|[ \t]*/g, " "],
];

/**
 * A markdown string reduced to one plain-text line, cut to `max` characters on a
 * word boundary.
 *
 * Lines are joined with " · " rather than a space, because what's being
 * previewed is list-shaped: "Progress · Shipped the close-out end to end ·
 * Blockers · none" stays readable, where a space-join runs the sections
 * together into one sentence that reads as nonsense.
 *
 * `truncated` reports whether anything was actually cut, so a caller can decide
 * whether there's more to show rather than guessing from the length.
 */
/**
 * Cut `s` to at most `max` chars on the last space in range, so a teaser never
 * ends mid-word. A single very long token takes the hard cut — a broken word
 * beats a column that wraps forever. Shared with the MCP response budget
 * (`@/lib/mcp-response`), so "don't end mid-word" means one thing everywhere.
 */
export function cutOnBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(
    /[\s·,;:.\-—]+$/,
    "",
  );
}

export function previewOf(
  markdown: string | null | undefined,
  max = 180,
): { preview: string; truncated: boolean } {
  if (!markdown?.trim()) return { preview: "", truncated: false };

  let text = markdown;
  for (const [re, to] of STRIP) text = text.replace(re, to);

  const flat = text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");

  if (flat.length <= max) return { preview: flat, truncated: false };

  return { preview: `${cutOnBoundary(flat, max)}…`, truncated: true };
}
