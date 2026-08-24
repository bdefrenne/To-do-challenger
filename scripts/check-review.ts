/**
 * Board-review checks — the pure rules behind the cleanup pass.
 *
 * `npm run check:review`
 *
 * `reviewFlags` is the one place the board's hygiene is judged, and its output
 * decides two things that are easy to get quietly wrong: WHICH tasks an agent
 * looks at first, and — because `capped()` drops rows from the tail — which ones
 * a truncated read silently loses. A wrong weight doesn't render oddly; it hides
 * the task that most needed attention.
 *
 * The flags are also load-bearing in a second way: they must stay OBSERVATIONS.
 * If one ever starts implying an action, an agent applies it without opening the
 * code, and the pass becomes a way to falsify the board rather than check it.
 *
 * Pure functions only: no database, no MCP, no clock.
 */

import {
  reviewFlags,
  reviewSeverity,
  workingDaysBetween,
  STALE_AFTER_DAYS,
  ONGOING_STATUSES,
  type ReviewFacts,
  type ReviewFlag,
} from "@/lib/db/service";
import type { TaskStatus } from "@/lib/types";

/* ------------------------------- harness ------------------------------- */

let passed = 0;
const failures: string[] = [];
let section = "";

const group = (name: string) => {
  section = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
};
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    failures.push(`${section} → ${name}\n       got  ${g}\n       want ${w}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       got  ${g}\n       want ${w}`);
  }
};

/** A clean task: freshly moved, fully written up, nothing to say about it. */
const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
  status: "building",
  placement: "thisWeek",
  daysInStatus: 0,
  daysSinceActivity: 0,
  hasEverLogged: true,
  updatedAt: "2026-08-24T09:00:00.000Z",
  updatedInWindow: true,
  inWindow: { events: 1, logs: 1, commits: 0 },
  has: { analysis: 500, plan: 500, summary: 500 },
  commitCount: 3,
  assigned: true,
  thresholds: STALE_AFTER_DAYS,
  ...over,
});

const names = (f: ReviewFlag[]) => f.map((x) => x.flag);
const has = (f: ReviewFlag[], flag: ReviewFlag["flag"]) =>
  f.some((x) => x.flag === flag);

/* --------------------------- working days ------------------------------ */

group("workingDaysBetween — weekends don't age a task");
{
  // 2026-08-24 is a Monday; the 21st is the Friday before it.
  eq("Friday → Monday is one working day, not three",
     workingDaysBetween("2026-08-21", "2026-08-24"), 1);
  eq("the same day is zero", workingDaysBetween("2026-08-24", "2026-08-24"), 0);
  eq("Monday → Tuesday is one", workingDaysBetween("2026-08-24", "2026-08-25"), 1);
  eq("Monday → Friday is four", workingDaysBetween("2026-08-24", "2026-08-28"), 4);
  eq("a full week is five, not seven",
     workingDaysBetween("2026-08-24", "2026-08-31"), 5);
  eq("Saturday → Sunday is zero — nothing was owed on either",
     workingDaysBetween("2026-08-22", "2026-08-23"), 0);
  eq("a backwards range is zero, never negative",
     workingDaysBetween("2026-08-31", "2026-08-24"), 0);
  eq("an ancient date is clamped, not unbounded",
     workingDaysBetween("1999-01-01", "2026-08-24"), 400);
}

/* ------------------------------- staleness ------------------------------ */

group("staleInStatus — the two ladders");
{
  eq("building is stale at 3 days",
     names(reviewFlags(facts({ status: "building", daysInStatus: 3 }))).includes("staleInStatus"),
     true);
  eq("…but not at 2",
     has(reviewFlags(facts({ status: "building", daysInStatus: 2 })), "staleInStatus"),
     false);
  eq("review gets 7 days — waiting on someone isn't stalling",
     has(reviewFlags(facts({ status: "review", daysInStatus: 5, has: { analysis: 1, plan: 1, summary: 1 } })), "staleInStatus"),
     false);
  eq("…and is stale at 7",
     has(reviewFlags(facts({ status: "review", daysInStatus: 7, has: { analysis: 1, plan: 1, summary: 1 } })), "staleInStatus"),
     true);
  eq("the threshold used is reported, so the number can be explained",
     reviewFlags(facts({ status: "analyzing", daysInStatus: 9, has: { analysis: 1, plan: 0, summary: 0 } }))
       .find((f) => f.flag === "staleInStatus"),
     { flag: "staleInStatus", days: 9, threshold: 3 });
  eq("a backlog item sitting still is a backlog item, not a problem",
     has(reviewFlags(facts({ status: "backlog", placement: "backlog", daysInStatus: 20, commitCount: 0 })), "staleInStatus"),
     false);
}

/* ----------------------------- silent edits ---------------------------- */

group("silentEdit — updatedAt moved and nothing explains it");
{
  const quiet = { events: 0, logs: 0, commits: 0 };
  eq("fires when the window turned up nothing at all",
     has(reviewFlags(facts({ updatedInWindow: true, inWindow: quiet })), "silentEdit"),
     true);
  eq("…because a title or description edit is deliberately never logged",
     reviewFlags(facts({ updatedInWindow: true, inWindow: quiet }))
       .find((f) => f.flag === "silentEdit"),
     { flag: "silentEdit", updatedAt: "2026-08-24T09:00:00.000Z" });
  eq("a single log entry explains the edit, so it doesn't fire",
     has(reviewFlags(facts({ updatedInWindow: true, inWindow: { ...quiet, logs: 1 } })), "silentEdit"),
     false);
  eq("a linked commit explains it too (linking bumps updatedAt)",
     has(reviewFlags(facts({ updatedInWindow: true, inWindow: { ...quiet, commits: 1 } })), "silentEdit"),
     false);
  eq("an untouched task is not a silent edit",
     has(reviewFlags(facts({ updatedInWindow: false, inWindow: quiet })), "silentEdit"),
     false);
  eq("no activity EVER is its own flag, separate from staleness",
     has(reviewFlags(facts({ hasEverLogged: false })), "noActivityEver"),
     true);
}

/* --------------------------- missing write-ups -------------------------- */

group("the working fields — what each status owes");
{
  eq("analyzing with no analysis",
     has(reviewFlags(facts({ status: "analyzing", has: { analysis: 0, plan: 0, summary: 0 } })), "analyzingNoAnalysis"),
     true);
  eq("building with no plan",
     has(reviewFlags(facts({ status: "building", has: { analysis: 9, plan: 0, summary: 0 } })), "buildingNoPlan"),
     true);
  eq("building with no linked commits",
     has(reviewFlags(facts({ status: "building", commitCount: 0 })), "buildingNoCommits"),
     true);
  eq("review with no summary",
     has(reviewFlags(facts({ status: "review", has: { analysis: 9, plan: 9, summary: 0 } })), "reviewNoSummary"),
     true);
  eq("a plan is not owed while still analyzing",
     has(reviewFlags(facts({ status: "analyzing", has: { analysis: 9, plan: 0, summary: 0 } })), "buildingNoPlan"),
     false);
  eq("a summary is not owed while building",
     has(reviewFlags(facts({ status: "building", has: { analysis: 9, plan: 9, summary: 0 } })), "reviewNoSummary"),
     false);
  eq("presence is length > 0 — a one-character plan counts",
     has(reviewFlags(facts({ status: "building", has: { analysis: 9, plan: 1, summary: 0 } })), "buildingNoPlan"),
     false);
}

/* ------------------------------- placement ----------------------------- */

group("placement — status and tray disagreeing");
{
  eq("done but never swept out of its tray",
     has(reviewFlags(facts({ status: "done", placement: "thisWeek" })), "doneNotSwept"),
     true);
  eq("done and swept is clean",
     has(reviewFlags(facts({ status: "done", placement: "doneThisWeek" })), "doneNotSwept"),
     false);
  eq("in flight but filed in BACKLOG",
     has(reviewFlags(facts({ status: "building", placement: "backlog" })), "workingNotThisWeek"),
     true);
  eq("in flight and in THIS WEEK is the normal case",
     has(reviewFlags(facts({ status: "building", placement: "thisWeek" })), "workingNotThisWeek"),
     false);
  eq("an INBOX task is untriaged",
     has(reviewFlags(facts({ status: "todo", placement: "inbox" })), "untriaged"),
     true);
  eq("a DONE task in inbox is unswept, not untriaged — it needs no triage",
     has(reviewFlags(facts({ status: "done", placement: "inbox" })), "untriaged"),
     false);
  eq("unassigned only counts while work is in flight",
     has(reviewFlags(facts({ status: "building", assigned: false })), "unassigned"),
     true);
  eq("…not on a backlog item nobody has picked up",
     has(reviewFlags(facts({ status: "backlog", placement: "backlog", assigned: false })), "unassigned"),
     false);
}

/* -------------------------------- ordering ----------------------------- */

group("severity — what a truncated read must never drop");
{
  const stale = reviewFlags(facts({ daysInStatus: 12 }));
  const tidy = reviewFlags(facts({ placement: "inbox" }));
  eq("a task rotting in its status outranks a merely untidy one",
     reviewSeverity(stale) > reviewSeverity(tidy), true);
  eq("a clean task scores zero", reviewSeverity(reviewFlags(facts())), 0);
  eq("`movedInWindow` alone is not a problem — it's context",
     reviewSeverity(reviewFlags(facts({ inWindow: { events: 2, logs: 0, commits: 0 } }))), 0);
  eq("…but it is still reported",
     has(reviewFlags(facts({ inWindow: { events: 2, logs: 0, commits: 0 } })), "movedInWindow"),
     true);
  eq("flags arrive worst-first within a task",
     names(reviewFlags(facts({
       status: "building",
       daysInStatus: 9,
       has: { analysis: 0, plan: 0, summary: 0 },
       commitCount: 0,
       inWindow: { events: 0, logs: 0, commits: 0 },
       updatedInWindow: false,
     })))[0],
     "staleInStatus");
  const stalled = reviewFlags(facts({
    status: "building", daysInStatus: 12, commitCount: 0,
    has: { analysis: 0, plan: 0, summary: 0 },
    inWindow: { events: 0, logs: 0, commits: 0 }, updatedInWindow: false,
  }));
  eq("a long-stalled unplanned build outranks a merely stale task",
     reviewSeverity(stalled) > reviewSeverity(reviewFlags(facts({ daysInStatus: 12 }))),
     true);
}

/* ------------------------------- the contract --------------------------- */

group("the contract — evidence, not recommendations");
{
  const every = reviewFlags(facts({
    status: "building", placement: "inbox", daysInStatus: 30,
    hasEverLogged: false, assigned: false, commitCount: 0,
    has: { analysis: 0, plan: 0, summary: 0 },
    inWindow: { events: 0, logs: 0, commits: 0 },
  }));
  eq("no flag carries an action, a recommendation or a suggested status",
     every.every((f) => {
       const keys = Object.keys(f);
       return !keys.some((k) => /action|recommend|suggest|should|next/i.test(k));
     }),
     true);
  eq("the worst possible task still only states facts",
     names(every).length, 8);
  eq("a clean, quiet task produces no flags at all — an honest board says nothing",
     names(reviewFlags(facts({
       inWindow: { events: 0, logs: 0, commits: 0 },
       updatedInWindow: false,
     }))),
     []);
  eq("every ongoing status has a threshold",
     ONGOING_STATUSES.every((s: TaskStatus) => typeof STALE_AFTER_DAYS[s] === "number"),
     true);
}

/* -------------------------------- summary ------------------------------- */

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n\n${failures.join("\n\n")}\n`
    : `\n\x1b[32mall ${passed} checks passed\x1b[0m\n`,
);
process.exit(failures.length ? 1 : 0);
