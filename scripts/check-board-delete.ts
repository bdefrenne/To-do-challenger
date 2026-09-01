/*
  BOARD/PROJECT DELETE CHECK — what blocks a delete, and what the delete takes
  with it (TD2-214).

  Deleting a board is the ONE exit in the app that ends tasks without the Trash:
  `tasks.board_id` is ON DELETE CASCADE, so whatever is still pointing at the
  board is gone from Postgres the moment the row goes. That makes the counting
  rule in `cascadeTaskCount` the whole safety model, and it is now a NARROWER
  rule than it was:

    • LIVE tasks block the delete — they're on someone's board, so they have to
      be moved or deleted first, through the door that has an undo.
    • ARCHIVED and TRASHED rows do NOT block it. They're out of every active
      view, and counting them refused a delete while naming tasks nobody could
      find anywhere (the Vivax board read empty and still wouldn't go).
    • …but they ARE destroyed by the cascade. `hiddenTaskCount` is what the
      confirm dialog reads so a person is told how many before they answer.

  Both halves have to be true at once, which is why they're checked together:
  a rule that only refused would strand boards, and a rule that only deleted
  would eat archived work in silence. Two ways to get this wrong that nothing
  else would notice — counting a hidden row as a blocker (the bug this fixes),
  or letting a LIVE task through the cascade (a task destroyed with no Trash).

  Runs against DATABASE_URL. Makes its own scratch project/boards/tasks and
  cleans up after itself — scratch tasks are binned AND purged, per the repo
  convention, so the Trash doesn't fill with test residue.

    npm run check:delete
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { eq, inArray } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { tasks, boards, users } from "../src/lib/db/schema";
import {
  createProject,
  createBoard,
  createTask,
  completeTask,
  archiveTask,
  deleteTask,
  purgeTask,
  deleteBoard,
  deleteProject,
  hiddenTaskCount,
} from "../src/lib/db/service";

const AUTHOR = "check:delete";
const TITLE = "[check:delete] scratch — safe to delete";

let ME = "";
let pass = 0;
const failures: string[] = [];
/** Everything made, torn down in `cleanup` whatever happens. */
const scratchProjects: string[] = [];
const scratchBoards: string[] = [];
const scratchTasks: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A board of our own, so nothing here can touch a real one. */
async function newBoard(projectId: string, name: string): Promise<string> {
  const board = await createBoard(ME, projectId, `[check:delete] ${name}`);
  if (!board) throw new Error("createBoard returned null");
  scratchBoards.push(board.id);
  return board.id;
}

/** `state` is what the task is when the delete is attempted — the whole point. */
async function newTask(
  boardId: string,
  state: "live" | "archived" | "trashed",
): Promise<string> {
  const t = await createTask({ title: TITLE, boardId }, ME, AUTHOR);
  scratchTasks.push(t.id);
  if (state === "archived") {
    // Only a DONE task can be archived — the same two steps a person takes.
    await completeTask(t.id, true, ME, AUTHOR);
    await archiveTask(t.id, true, ME, AUTHOR);
  }
  if (state === "trashed") await deleteTask(t.id, ME, AUTHOR);
  return t.id;
}

/** How many `tasks` rows still exist, by id — the cascade's own account. */
async function rowsLeft(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids));
  return rows.length;
}

async function boardGone(id: string): Promise<boolean> {
  const rows = await db.select({ id: boards.id }).from(boards).where(eq(boards.id, id));
  return rows.length === 0;
}

/** Returns the ValidationError a refused delete throws, or null if it went through. */
async function refusal(fn: () => Promise<boolean>): Promise<{ message: string; taskCount?: number } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const err = e as { message: string; details?: { taskCount?: number } };
    return { message: err.message, taskCount: err.details?.taskCount };
  }
}

async function main() {
  const [me] = await db.select({ id: users.id }).from(users).limit(1);
  if (!me) throw new Error("no users in the roster");
  ME = me.id;

  const project = await createProject(ME, "[check:delete] scratch project");
  scratchProjects.push(project.id);

  /* ---- What blocks the delete ---------------------------------------- */
  console.log("\nA LIVE task blocks the delete; a hidden one doesn't");
  {
    const boardId = await newBoard(project.id, "live task");
    const taskId = await newTask(boardId, "live");
    const r = await refusal(() => deleteBoard(ME, boardId));
    check("a board holding a live task is REFUSED", r !== null, "it deleted");
    check("…and the refusal counts it", r?.taskCount === 1, `taskCount=${r?.taskCount}`);
    check("…and the board is still there", !(await boardGone(boardId)), "board gone");
    check("…and the task is still there", (await rowsLeft([taskId])) === 1, "task destroyed");
  }
  {
    // The Vivax case: done, archived seconds later, invisible on every view —
    // and the only thing standing between the board and the bin.
    const boardId = await newBoard(project.id, "archived only");
    const taskId = await newTask(boardId, "archived");
    const gone = await deleteBoard(ME, boardId);
    check("a board holding only an ARCHIVED task deletes", gone === true, "refused");
    check("…and the board row is gone", await boardGone(boardId), "board survived");
    check(
      "…and the archived task went with it (no Trash — that's the trade)",
      (await rowsLeft([taskId])) === 0,
      "task row survived the cascade",
    );
  }
  {
    const boardId = await newBoard(project.id, "trashed only");
    const taskId = await newTask(boardId, "trashed");
    const gone = await deleteBoard(ME, boardId);
    check("a board holding only a TRASHED task deletes", gone === true, "refused");
    check("…and the trashed task is purged by the cascade", (await rowsLeft([taskId])) === 0);
  }
  {
    // The count in the message is what the person acts on: it must name the
    // tasks they can actually go and move, not the ones they can't see.
    const boardId = await newBoard(project.id, "one of each");
    const live = await newTask(boardId, "live");
    await newTask(boardId, "archived");
    await newTask(boardId, "trashed");
    const r = await refusal(() => deleteBoard(ME, boardId));
    check("a mixed board is refused on its live task alone", r?.taskCount === 1, `taskCount=${r?.taskCount}`);
    check(
      "…and the message says '1 task', not 3",
      !!r && r.message.includes("1 task") && !r.message.includes("3 task"),
      r?.message,
    );

    /* ---- What the warning tells the person ------------------------------ */
    console.log("\nhiddenTaskCount — what the confirm dialog names");
    const hidden = await hiddenTaskCount({ boardId });
    check("counts the archived row", hidden.archived === 1, `archived=${hidden.archived}`);
    check("counts the trashed row", hidden.trashed === 1, `trashed=${hidden.trashed}`);
    check(
      "does NOT count the live one (it's blocking, not hidden)",
      hidden.archived + hidden.trashed === 2,
      JSON.stringify(hidden),
    );

    // A task that was archived and THEN deleted is one row, so it must be
    // counted once — as trashed, the state it's actually in.
    const both = await newTask(boardId, "archived");
    await deleteTask(both, ME, AUTHOR);
    const after = await hiddenTaskCount({ boardId });
    check(
      "an archived-then-trashed row counts once, as trashed",
      after.archived === 1 && after.trashed === 2,
      JSON.stringify(after),
    );

    // Free the board so cleanup can take it.
    await scrub(live);
  }

  /* ---- The same rule, one level up ------------------------------------ */
  console.log("\nA project follows the same rule");
  {
    const p = await createProject(ME, "[check:delete] scratch project 2");
    scratchProjects.push(p.id);
    const boardId = await newBoard(p.id, "project archived only");
    const taskId = await newTask(boardId, "archived");

    const hidden = await hiddenTaskCount({ projectId: p.id });
    check("hiddenTaskCount sees the project's archived task", hidden.archived === 1, JSON.stringify(hidden));

    const live = await newTask(boardId, "live");
    const r = await refusal(() => deleteProject(ME, p.id));
    check("a project with a live task is REFUSED", r?.taskCount === 1, `taskCount=${r?.taskCount}`);
    await scrub(live);

    const gone = await deleteProject(ME, p.id);
    check("…and deletes once only hidden rows are left", gone === true, "refused");
    check("…taking the archived task with it", (await rowsLeft([taskId])) === 0, "row survived");
  }
}

/** Cleanup means GONE: DELETE is a soft delete (TD2-196), so a scratch task
 *  binned and not purged would sit in the Trash after every run. */
async function scrub(id: string): Promise<void> {
  await deleteTask(id, ME, AUTHOR);
  await purgeTask(id, ME);
}

async function cleanup() {
  for (const id of scratchTasks) {
    try {
      await scrub(id);
    } catch {
      /* already gone with a cascade — expected for the deleted boards */
    }
  }
  for (const id of scratchBoards) {
    try {
      await deleteBoard(ME, id);
    } catch (e) {
      console.warn(`  ! scratch board ${id} not deleted — ${(e as Error).message}`);
    }
  }
  for (const id of scratchProjects) {
    try {
      await deleteProject(ME, id);
    } catch (e) {
      console.warn(`  ! scratch project ${id} not deleted — ${(e as Error).message}`);
    }
  }
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${pass} passed, ${failures.length} failed.`);
    if (failures.length) {
      console.error("\nFailures:\n" + failures.map((f) => `  • ${f}`).join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
