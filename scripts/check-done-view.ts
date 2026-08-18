/*
  DONE VIEW CHECK — the rules the Done view rests on, in isolation.

  The view reads completions from the status-event log, not from `tasks.status`,
  because a completion is an EVENT: it has a date, an owner, and it can happen to
  the same task more than once. Two rules turn that log into a readable grid, and
  both are easy to get subtly wrong:

    • WHICH events become rows (`pickCompletions`) — one per (task, credited
      person, day). Collapse it per task instead and history rewrites itself on
      every reopen; forget the person and a co-assigned card loses a column;
      forget the credited-beats-uncredited rule and one card shows up twice in
      the same day, once under a name and once under "no assignee".

    • WHICH DAY an event falls on. Two axes, applied in order, and both easy to
      get wrong in a way that silently misfiles work:

        1. The reader's ZONE, not UTC. Bucket 22:00 Brussels on the UTC date and
           it lands under the wrong header AND, at a week boundary, the wrong week.

        2. The WORKING day, which runs 04:00 → 04:00 (`DAY_BOUNDARY_HOUR`), not
           midnight to midnight. A task finished at half past midnight Brussels
           time is *Monday's* work — the end of a long evening, not the start of
           Tuesday. Splitting it onto Tuesday puts it in a standup that hadn't
           happened yet and removes it from the one that had.

      And `workedOn`, which overrides the derived day outright for work recorded
      after the fact. `at` is when we learned; `workedOn` is which day it counts
      for.

  Pure logic, no DB.

    npm run check:done
*/

import { pickCompletions, type DoneEvent } from "../src/lib/db/service";
import { addDays, fromYmd, startOfWeek, ymd } from "../src/lib/dates";
import { previewOf } from "../src/lib/format";
import { APP_TIMEZONE, dateWindow, workingDayOf } from "../src/lib/workday";

let failures = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "✓" : "✗"} ${label}`,
    ok ? "" : `\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`,
  );
};

/** An event, newest-first order being the caller's job. */
const ev = (taskId: string, creditedTo: string | null, at: string): DoneEvent => ({
  taskId,
  creditedTo,
  at: new Date(at),
});

/** Sort newest-first the way the query does, so the fixtures can be written in
 *  any order without silently violating `pickCompletions`'s precondition. */
const newestFirst = (list: DoneEvent[]) =>
  [...list].sort((a, b) => b.at.getTime() - a.at.getTime());

const rows = (list: DoneEvent[], tz = "UTC") =>
  pickCompletions(newestFirst(list), tz).map((r) => `${r.taskId}/${r.creditedTo ?? "-"}/${r.day}`);

/* ---- 1. one row per (task, person, day) ---------------------------------- */

check(
  "two completions of one task in the same day collapse to one",
  rows([ev("t1", "ben", "2026-08-13T09:00:00Z"), ev("t1", "ben", "2026-08-13T17:00:00Z")]),
  ["t1/ben/2026-08-13"],
);

check(
  "…and it's the LATEST one that survives",
  pickCompletions(
    newestFirst([
      ev("t1", "ben", "2026-08-13T09:00:00Z"),
      ev("t1", "ben", "2026-08-13T17:00:00Z"),
    ]),
    "UTC",
  ).map((r) => r.at.toISOString()),
  ["2026-08-13T17:00:00.000Z"],
);

check(
  "finished, reopened, finished again on another day → both days",
  rows([ev("t1", "ben", "2026-08-06T10:00:00Z"), ev("t1", "ben", "2026-08-13T10:00:00Z")]),
  ["t1/ben/2026-08-13", "t1/ben/2026-08-06"],
);

check(
  "a two-assignee task lands in both people's columns",
  rows([ev("t1", "ben", "2026-08-13T10:00:00Z"), ev("t1", "antho", "2026-08-13T10:00:00Z")]),
  ["t1/ben/2026-08-13", "t1/antho/2026-08-13"],
);

check(
  "output stays newest-first",
  rows([
    ev("a", "ben", "2026-08-11T10:00:00Z"),
    ev("b", "ben", "2026-08-14T10:00:00Z"),
    ev("c", "ben", "2026-08-12T10:00:00Z"),
  ]),
  ["b/ben/2026-08-14", "c/ben/2026-08-12", "a/ben/2026-08-11"],
);

/* ---- 2. credited beats uncredited, within a day -------------------------- */

check(
  "closed twice in one day, once unassigned → only the credited row",
  rows([ev("t1", "ben", "2026-08-13T09:00:00Z"), ev("t1", null, "2026-08-13T17:00:00Z")]),
  ["t1/ben/2026-08-13"],
);

check(
  "…but an uncredited close on a DIFFERENT day keeps its own row",
  rows([ev("t1", "ben", "2026-08-13T09:00:00Z"), ev("t1", null, "2026-08-14T09:00:00Z")]),
  ["t1/-/2026-08-14", "t1/ben/2026-08-13"],
);

check(
  "a task only ever closed unassigned still shows",
  rows([ev("t1", null, "2026-08-13T09:00:00Z")]),
  ["t1/-/2026-08-13"],
);

check(
  "one person's credit doesn't suppress another task's null row that day",
  rows([ev("t1", "ben", "2026-08-13T09:00:00Z"), ev("t2", null, "2026-08-13T10:00:00Z")]),
  ["t2/-/2026-08-13", "t1/ben/2026-08-13"],
);

/* ---- 3. the day is the READER's day ------------------------------------- */

check(
  "21:00 UTC is still the same evening in Brussels (CEST, +2)",
  rows([ev("t1", "ben", "2026-08-13T21:00:00Z")], "Europe/Brussels"),
  ["t1/ben/2026-08-13"],
);

check(
  "06:00 UTC is the Brussels working day it falls in",
  rows([ev("t1", "ben", "2026-08-14T06:00:00Z")], "Europe/Brussels"),
  ["t1/ben/2026-08-14"],
);

check(
  "the zone still decides: 02:00 UTC is the previous day in New York (EDT, −4)",
  // 22:00 the night before, local — squarely inside the previous working day,
  // where a naive UTC read would file it under the 14th.
  rows([ev("t1", "ben", "2026-08-14T02:00:00Z")], "America/New_York"),
  ["t1/ben/2026-08-13"],
);

check(
  "winter offset too — 04:30 UTC in January is that day in Brussels (CET, +1)",
  // 05:30 local, just past the boundary.
  rows([ev("t1", "ben", "2026-01-14T04:30:00Z")], "Europe/Brussels"),
  ["t1/ben/2026-01-14"],
);

/* ---- 3b. a working day runs 04:00 → 04:00, not midnight → midnight ------
   Finishing something at 01:00 is the end of a long evening, not the start of a
   new day. Filing it under the new date would put it in a standup that hadn't
   happened yet AND strip it out of the one that had — so the boundary sits in
   the small hours, where nobody is working. `DAY_BOUNDARY_HOUR` is the knob.

   This is a SEPARATE axis from the zone above: first resolve the reader's local
   time, then decide which working day that local time belongs to. */

check(
  "01:30 local is the PREVIOUS working day (Brussels, CEST +2 ⇒ 23:30Z)",
  rows([ev("t1", "ben", "2026-08-13T23:30:00Z")], "Europe/Brussels"),
  ["t1/ben/2026-08-13"],
);

check(
  "03:59 local is still the previous working day",
  rows([ev("t1", "ben", "2026-08-14T01:59:00Z")], "Europe/Brussels"),
  ["t1/ben/2026-08-13"],
);

check(
  "04:00 local starts the new one",
  rows([ev("t1", "ben", "2026-08-14T02:00:00Z")], "Europe/Brussels"),
  ["t1/ben/2026-08-14"],
);

check(
  "23:00 and 01:30 are ONE evening's work, so they collapse to one row",
  // The pre-boundary rule split these across two days, which is what put half of
  // a late session into tomorrow's standup.
  rows(
    [ev("t1", "ben", "2026-08-13T21:00:00Z"), ev("t1", "ben", "2026-08-13T23:30:00Z")],
    "Europe/Brussels",
  ),
  ["t1/ben/2026-08-13"],
);

check(
  "…and the LATEST of the two is the one kept",
  pickCompletions(
    newestFirst([
      ev("t1", "ben", "2026-08-13T21:00:00Z"),
      ev("t1", "ben", "2026-08-13T23:30:00Z"),
    ]),
    "Europe/Brussels",
  ).map((r) => r.at.toISOString()),
  ["2026-08-13T23:30:00.000Z"],
);

check(
  "a real day boundary still separates two rows",
  rows(
    [ev("t1", "ben", "2026-08-13T10:00:00Z"), ev("t1", "ben", "2026-08-14T10:00:00Z")],
    "Europe/Brussels",
  ),
  ["t1/ben/2026-08-14", "t1/ben/2026-08-13"],
);

/* ---- 3c. `workedOn` overrides the derived day ---------------------------
   `at` is when we LEARNED and never changes; `workedOn` is which day the work
   BELONGS to. Set only where those genuinely differ — work written up the next
   morning, and the Done view's re-dating. Everything else leaves it null and
   gets the derived day, which is right. */

check(
  "an explicit workedOn wins over the day `at` falls in",
  rows([{ ...ev("t1", "ben", "2026-08-14T10:00:00Z"), workedOn: "2026-08-13" }]),
  ["t1/ben/2026-08-13"],
);

check(
  "…and it buckets with work genuinely done that day, as one row",
  rows([
    ev("t1", "ben", "2026-08-13T16:00:00Z"),
    { ...ev("t1", "ben", "2026-08-14T09:00:00Z"), workedOn: "2026-08-13" },
  ]),
  ["t1/ben/2026-08-13"],
);

check(
  "a null workedOn is 'derive it', not 'unknown'",
  rows([{ ...ev("t1", "ben", "2026-08-13T16:00:00Z"), workedOn: null }]),
  ["t1/ben/2026-08-13"],
);

check(
  "re-dating one of two rows separates them",
  // Note the ORDER: rows stay sorted by `at` (t2 was recorded five minutes
  // later), while the day each one buckets into comes from `workedOn`. The two
  // don't have to agree, and a re-dated row is exactly where they don't — so the
  // view sorts on when we learned and groups on what it counts for.
  rows([
    ev("t1", "ben", "2026-08-14T09:00:00Z"),
    { ...ev("t2", "ben", "2026-08-14T09:05:00Z"), workedOn: "2026-08-13" },
  ]),
  ["t2/ben/2026-08-13", "t1/ben/2026-08-14"],
);

/* ---- 3d. the DEFAULT zone is a real one, not UTC -------------------------
   Server-side readers have no browser to ask — the MCP `standup` tool and
   `standup_report` prompt pass no zone at all. With a UTC default the boundary
   would land at 04:00 UTC, which is 06:00 here: a whole early-morning shift
   credited to the previous day. These pin the default so that can't come back.

   There's no "and it isn't UTC" assertion because the compiler already refuses
   that comparison — `APP_TIMEZONE`'s literal type makes it statically false,
   which is a stronger guarantee than a runtime check. */

check(
  "a day with no zone given spans the working day in APP_TIMEZONE",
  (() => {
    const w = dateWindow("2026-08-04", "2026-08-04");
    return [w.start?.toISOString(), w.end?.toISOString()];
  })(),
  // 04:00 Brussels in August (CEST, +2) is 02:00Z, and the end is exclusive.
  ["2026-08-04T02:00:00.000Z", "2026-08-05T02:00:00.000Z"],
);

check(
  "09:00 local on a summer morning is that same working day",
  workingDayOf(new Date("2026-08-04T07:00:00Z"), APP_TIMEZONE),
  "2026-08-04",
);

check(
  "…and 05:00 local is too — the regression this pins",
  // 03:00Z is 05:00 Brussels: past the 04:00 boundary, so it is TODAY's work.
  // Under a UTC default this read as 03:00 UTC, i.e. before the boundary, and
  // was credited to the day before.
  workingDayOf(new Date("2026-08-04T03:00:00Z"), APP_TIMEZONE),
  "2026-08-04",
);

/* ---- 4. the week the view files a day under ------------------------------ */

const weekOf = (day: string) => ymd(startOfWeek(fromYmd(day)));

check("Monday is its own week start", weekOf("2026-08-17"), "2026-08-17");
check("Sunday belongs to the week that STARTED — not the next one", weekOf("2026-08-16"), "2026-08-10");
check("Saturday too", weekOf("2026-08-15"), "2026-08-10");

/* The loaded range must tile: four chunks of four weeks are sixteen distinct,
   consecutive Mondays with no gap and no repeat, or a completion falls into a
   week the view never draws. */
const chunkWeeks = 4;
const monday = startOfWeek(new Date(2026, 7, 17));
for (const chunks of [1, 2, 4]) {
  const total = chunks * chunkWeeks;
  const starts = Array.from({ length: total }, (_, i) => ymd(addDays(monday, -7 * i)));
  check(`${total} weeks back are distinct`, new Set(starts).size, total);
  check(
    `${total} weeks back are consecutive`,
    starts.every((s, i) => i === 0 || ymd(addDays(fromYmd(s), 7)) === starts[i - 1]),
    true,
  );
}

/* The days a week's header covers — Monday through the Sunday shown beside it. */
check(
  "a week header spans exactly seven days",
  ymd(addDays(fromYmd("2026-08-10"), 6)),
  "2026-08-16",
);

/* ---- The standup teaser (`previewOf`) ------------------------------------

   A person's column is headed by the standup they wrote, and only ONE LINE of it
   crosses the wire — the prose stays in Postgres (PLAT-403) and the full text is
   fetched for the one column someone opens. So the teaser has to carry the day on
   its own, and the thing that breaks it is markdown: the Finish work prompt asks
   for "Progress / Blockers / Questions / To review", so a standup almost always
   OPENS WITH A HEADING. Render-then-clamp spends the whole header on the word
   "Progress"; this strips the syntax instead and joins the lines. */

const standup = [
  "## Progress",
  "",
  "Shipped the **work-day close-out** end to end — the `04:00` boundary re-buckets",
  "the DONE view retroactively.",
  "",
  "- Migration 0032 applied",
  "- See [TD-65](https://example.com/x) for detail",
].join("\n");

const teaser = previewOf(standup);
check(
  "the teaser leads with CONTENT, not the heading's markup",
  teaser.preview.startsWith("Progress · Shipped the work-day close-out"),
  true,
);
check("…with no markdown syntax left in it", /[#*`\[\]()]/.test(teaser.preview), false);
check("…joined with the section separator", teaser.preview.includes(" · "), true);
check("…and a standup this length is shown whole", teaser.truncated, false);

/* Cut it short to exercise the truncation itself: within budget, flagged, and
   never ending mid-word — a teaser that stops halfway through "retroactively"
   reads as a rendering bug rather than as an elision. */
const cut = previewOf(standup, 60);
check("a long standup is cut to the budget", cut.preview.length <= 61, true);
check("…and reported as truncated", cut.truncated, true);
check("…marked with an ellipsis", /\S…$/.test(cut.preview), true);
/* The real invariant: what's kept is a prefix of the whole line ending exactly
   where a space was — so no word is ever half-shown. (Ending in a letter proves
   nothing on its own; every clean cut does.) */
const kept = cut.preview.slice(0, -1);
check(
  "…cut exactly at a space in the full line",
  teaser.preview.startsWith(kept) &&
    teaser.preview.slice(kept.length).startsWith(" "),
  true,
);

/* A short standup is shown whole — `truncated` false is what tells the view there
   is nothing to fetch when the header is opened. */
const short = previewOf("- out Thursday pm\n- needs a browser pass");
check("a short write-up is not truncated", short.truncated, false);
check("…and keeps both lines", short.preview, "out Thursday pm · needs a browser pass");

/* Nothing written = nothing to head a column with. The service drops these rows
   rather than shipping an empty header, which reads as a standup that said
   nothing. */
check("whitespace previews as empty", previewOf("   \n\n  ").preview, "");
check("null previews as empty", previewOf(null).preview, "");

/* Emphasis stripping must not eat ordinary underscores — `snake_case` is all over
   a standup about code. */
check(
  "snake_case survives the emphasis stripper",
  previewOf("*done*: the worked_on column and _why_").preview,
  "done: the worked_on column and why",
);

/* A fenced block is dropped whole: a code sample says nothing about a day, and
   its newlines would otherwise become half a dozen " · " separators. */
check(
  "fenced code is dropped, not flattened",
  previewOf("Ran it:\n\n```sql\nselect 1\nfrom t\n```\n\nGreen.").preview,
  "Ran it: · Green.",
);

console.log(failures ? `\n${failures} FAILED` : "\nAll done-view checks passed");
process.exit(failures ? 1 : 0);
