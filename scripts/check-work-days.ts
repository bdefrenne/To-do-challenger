/*
  WORK DAYS CHECK — the parts of the work-day feature that typecheck but could
  still be wrong, against the real schema.

  Five things here can only fail at the database:

    • The composite upsert. One row per (user, project, day) — get the conflict
      target wrong and "Ready for the day" silently accumulates duplicate rows,
      which nothing else would notice until a day had two snapshots.

    • The DERIVED sealing rule. A day is sealed once a LATER day is drafted;
      there is no column to inspect, so the only way to know the query is right
      is to draft two days and ask.

    • `worked_on` reaching the status event. Work logged after the fact rides an
      ambient request context through create-and-complete; if the stamp is lost
      anywhere on that path the row lands on today and looks perfectly normal.

    • The write-ups riding along on `listCompletions`. The Done view heads each
      person's column with the standup they wrote for that day, so a TEASER has to
      arrive keyed by (person, day) — and the prose must NOT, because a Done read
      spans four weeks × a whole team and authored text in a collection read is
      what PLAT-403 removed. It also has to be absent from the reads it would
      misrepresent: a board-scoped slice of a day, or another person's.

    • `effectiveWindow` — the predicate that reads a re-dated row back. It has
      two branches (`worked_on` as a date, `at` as an instant) precisely because
      the two columns aren't comparable, so both branches need exercising: the
      row must appear under the day it counts for AND be absent from the day it
      was recorded on. Getting this half-right hides work rather than misfiling
      it, which is worse.

  Uses SENTINEL days in 1999, so it cannot collide with a real working day, and
  deletes everything it creates.

    npm run check:day
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { db } from "../src/lib/db/client";
import { workDays, tasks, taskStatusEvents } from "../src/lib/db/schema";
import {
  getWorkDay,
  markDayReady,
  finishWork,
  workDayReview,
  logPastWork,
  listCompletions,
  listOpenDays,
} from "../src/lib/db/service";
import { currentWorkingDay } from "../src/lib/workday";
import { withLogContext } from "../src/lib/db/log-context";
import { and, eq, inArray } from "drizzle-orm";

const USER = "997dcb30-582f-418c-ad89-aa1b4e223020"; // Ben
const PROJECT = "7357c84e-bb8a-4c3b-b0b8-a5b42978c3c9"; // To Do Challenger
const BOARD = "b5cd0666-36ae-4d20-b99b-43fa5b1aa684"; // TD
const D1 = "1999-01-04";
const D2 = "1999-01-05";
const D3 = "1999-01-06";
/** Left UNDRAFTED on purpose — the fixture for `listOpenDays`. */
const D4 = "1999-01-07";
const TZ = "Europe/Brussels";
/* Sentinel days are ~27 years back, so any real lookback window excludes them.
   The open-days checks pass a window wide enough to reach them. */
const WIDE_LOOKBACK = 20_000;

let failures = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "✓" : "✗"} ${label}`,
    ok ? "" : `\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`,
  );
};

const created: string[] = [];

async function main() {
  // ---- a day with no row still answers -----------------------------------
  const empty = await getWorkDay(USER, PROJECT, D1);
  check("an unrecorded day is readable", [empty.day, empty.readyAt, empty.sealed], [D1, null, false]);

  // ---- ready: only ever for the day you're actually in -------------------
  /* A snapshot is of the list AS IT STANDS, so back-dating one would store a
     fiction — and every drift figure derived from it would be nonsense. */
  let readyRefused = "";
  try {
    await markDayReady(USER, PROJECT, D1);
  } catch (e) {
    readyRefused = (e as Error).message.slice(0, 18);
  }
  check("ready_for_day refuses a day that isn't today", readyRefused, "A snapshot records");

  /* So the happy path has to run for the CURRENT day. That's harmless by design —
     re-pressing is DEFINED as overwriting, "the last commitment of the morning is
     the real one" — which is also why cleanup below leaves today's row alone
     rather than deleting what might be a real snapshot. */
  const TODAY = currentWorkingDay(TZ);
  const r1 = await markDayReady(USER, PROJECT, TODAY);
  check("ready_for_day writes a snapshot for today", Array.isArray(r1.snapshot), true);
  const r2 = await markDayReady(USER, PROJECT, TODAY);
  check("…and re-pressing upserts rather than duplicating", r2.day, TODAY);
  const rows = await db
    .select({ id: workDays.id })
    .from(workDays)
    .where(and(eq(workDays.userId, USER), eq(workDays.projectId, PROJECT), eq(workDays.day, TODAY)));
  check("exactly one row per (user, project, day)", rows.length, 1);

  /* D1 still needs a snapshot for the drift assertions at the end. Seeded
     directly, because the service correctly refuses to back-date one — a fixture
     for downstream behaviour, not a way around the rule being tested above. */
  await db
    .insert(workDays)
    .values({
      userId: USER,
      projectId: PROJECT,
      day: D1,
      readyAt: new Date(),
      snapshot: [{ taskId: "seed-not-a-real-task", title: "seeded plan", status: "todo" }],
    })
    .onConflictDoUpdate({
      target: [workDays.userId, workDays.projectId, workDays.day],
      set: { readyAt: new Date() },
    });

  // ---- finish: drafts, and does not seal itself --------------------------
  const f1 = await finishWork(USER, PROJECT, D1, { summary: "scratch", bullets: "b" });
  check("finish_work drafts the day", [Boolean(f1.draftedAt), f1.summary, f1.sealed], [true, "scratch", false]);

  // ---- sealing is derived from a LATER drafted day ------------------------
  await finishWork(USER, PROJECT, D2, { summary: "next day" });
  const afterLater = await getWorkDay(USER, PROJECT, D1);
  check("drafting a later day seals the earlier one", afterLater.sealed, true);
  check("…and the later day is not sealed itself", (await getWorkDay(USER, PROJECT, D2)).sealed, false);

  let refused = "";
  try {
    await finishWork(USER, PROJECT, D1, { summary: "again" });
  } catch (e) {
    refused = (e as Error).message.slice(0, 24);
  }
  check("finish_work refuses a sealed day", refused, "Working day 1999-01-04 i");

  // ---- workedOn: a retro task lands on the sentinel day ------------------
  const task = await withLogContext({ actorId: USER, source: "api" }, () =>
    logPastWork(USER, { title: "TD-65 scratch: retro call", day: D1, boardId: BOARD }),
  );
  created.push(task.id);
  const evs = await db
    .select({ workedOn: taskStatusEvents.workedOn, to: taskStatusEvents.toStatus })
    .from(taskStatusEvents)
    .where(eq(taskStatusEvents.taskId, task.id));
  check(
    "log_past_work stamps worked_on on its status event(s)",
    evs.every((e) => e.workedOn === D1),
    true,
  );
  check("…and the task is done", task.status, "done");

  // ---- effectiveWindow: the re-dated row reads back on the sentinel day --
  const page = await listCompletions(USER, { from: D1, to: D1, projectId: PROJECT, tz: "Europe/Brussels" });
  check(
    "listCompletions finds it under the worked_on day",
    page.entries.some((e) => e.task.id === task.id && e.day === D1),
    true,
  );
  const other = await listCompletions(USER, { from: D2, to: D2, projectId: PROJECT, tz: "Europe/Brussels" });
  check(
    "…and NOT under the day it was recorded on",
    other.entries.some((e) => e.task.id === task.id),
    false,
  );

  // ---- the standup rides along on the Done view's read -------------------
  const mine = (page.writeUps ?? []).find(
    (w) => w.userId === USER && w.day === D1,
  );
  check(
    "listCompletions carries the day's standup as a teaser",
    [mine?.preview, mine?.hasMore, Boolean(mine?.draftedAt)],
    // Summary and bullets both present, so there is more than the teaser shows.
    ["scratch", true, true],
  );
  check(
    "…and carries NO prose columns (PLAT-403)",
    mine && ("summary" in mine || "bullets" in mine),
    false,
  );

  /* The guarantee this change exists for: a long write-up must come back cut, or
     the Done view is back to shipping the whole team's prose on every load. */
  const long = "Shipped a great deal today. ".repeat(40); // ~1.1 KB
  await finishWork(USER, PROJECT, D2, { summary: long });
  const d2 = await listCompletions(USER, {
    from: D2,
    to: D2,
    projectId: PROJECT,
    tz: "Europe/Brussels",
  });
  const cut = (d2.writeUps ?? []).find((w) => w.day === D2);
  check(
    "a long standup crosses the wire truncated, not whole",
    [
      (cut?.preview.length ?? 0) < 250,
      cut?.hasMore,
      cut?.preview.endsWith("…"),
    ],
    [true, true, true],
  );

  const scoped = await listCompletions(USER, {
    from: D1,
    to: D1,
    projectId: PROJECT,
    boardId: BOARD,
    tz: "Europe/Brussels",
  });
  check(
    "…but not on a board-scoped read (the prose is about the whole day)",
    scoped.writeUps,
    undefined,
  );

  const someoneElse = await listCompletions(USER, {
    from: D1,
    to: D1,
    projectId: PROJECT,
    creditedTo: "__no_such_user__",
    tz: "Europe/Brussels",
  });
  check(
    "…and narrowing to a person narrows the prose to them",
    someoneElse.writeUps,
    undefined,
  );

  // A day drafted with nothing written in it must not produce an empty header.
  await finishWork(USER, PROJECT, D3, { summary: "   ", bullets: null });
  const blank = await listCompletions(USER, {
    from: D3,
    to: D3,
    projectId: PROJECT,
    tz: "Europe/Brussels",
  });
  check("a drafted day with no prose yields no write-up", blank.writeUps, undefined);

  // ---- the review payload assembles -------------------------------------
  const review = await workDayReview(USER, PROJECT, D1, "Europe/Brussels");
  check("workDayReview returns a day + digest", [review.day.day, typeof review.digest], [D1, "object"]);
  check("…with drift, since a snapshot exists", Boolean(review.drift), true);
  check(
    "…and the retro task shows as done-but-not-planned",
    review.drift?.doneNotPlanned.some((t) => t.id === task.id) ?? false,
    true,
  );

  // ---- finish refuses a day that hasn't happened -------------------------
  /* A future draft would seal every real day behind it, and there is no unseal —
     so this is the difference between a typo and an unrecoverable board. */
  let futureRefused = "";
  try {
    await finishWork(USER, PROJECT, "2999-01-01", { summary: "from the future" });
  } catch (e) {
    futureRefused = (e as Error).message.slice(0, 26);
  }
  check("finish_work refuses a future day", futureRefused, "2999-01-01 hasn't happened");

  // ---- a malformed snapshot degrades, rather than reaching the view ------
  await db
    .update(workDays)
    .set({ snapshot: "not an array at all" })
    .where(and(eq(workDays.userId, USER), eq(workDays.projectId, PROJECT), eq(workDays.day, D2)));
  check(
    "a garbage snapshot column reads as 'none taken', not a crash",
    (await getWorkDay(USER, PROJECT, D2)).snapshot,
    null,
  );

  // ---- open days: the debt the close-out collects ------------------------
  /* D4 gets work but is never drafted — the day you forgot. */
  const d4task = await withLogContext({ actorId: USER, source: "api" }, () =>
    logPastWork(USER, { title: "TD-65 scratch: unclosed day", day: D4, boardId: BOARD }),
  );
  created.push(d4task.id);

  const open = await listOpenDays(USER, PROJECT, { lookbackDays: WIDE_LOOKBACK, tz: TZ });
  check("listOpenDays finds a day with work and no draft", open.includes(D4), true);
  check("…and excludes the days already drafted", open.includes(D1) || open.includes(D3), false);
  check("…and never nags about the day in progress", open.includes(TODAY), false);
  check("…newest first", [...open].sort().reverse().join() === open.join(), true);

  await finishWork(USER, PROJECT, D4, { summary: "closed it out" });
  check(
    "…and it drops off once drafted",
    (await listOpenDays(USER, PROJECT, { lookbackDays: WIDE_LOOKBACK, tz: TZ })).includes(D4),
    false,
  );

  /* The real window must not reach back 27 years, or every ancient day would
     read as a debt. */
  check(
    "the default lookback ignores sentinel-era days",
    (await listOpenDays(USER, PROJECT, { tz: TZ })).includes(D4),
    false,
  );

  const otherProject = await listOpenDays(USER, "__no_such_project__", {
    lookbackDays: WIDE_LOOKBACK,
    tz: TZ,
  });
  check("…and another project's days aren't yours to close", otherProject.length, 0);

  check(
    "the review carries the open days",
    (await workDayReview(USER, PROJECT, D1, TZ)).openDays.includes(D4),
    false, // D4 was drafted just above
  );
}

main()
  .catch((e) => {
    failures++;
    console.error("THREW:", e);
  })
  .finally(async () => {
    // Clean up everything this script created.
    if (created.length) await db.delete(tasks).where(inArray(tasks.id, created));
    await db
      .delete(workDays)
      .where(and(eq(workDays.userId, USER), eq(workDays.projectId, PROJECT), inArray(workDays.day, [D1, D2, D3, D4])));
    /* Today's row is deliberately NOT deleted: it may be a real snapshot, and
       re-taking one is a no-op by design. Only the 1999 sentinels go. */
    console.log(`\nCleaned up ${created.length} scratch task(s) + sentinel work days.`);
    console.log(failures ? `${failures} FAILED` : "All work-day checks passed");
    process.exit(failures ? 1 : 0);
  });
