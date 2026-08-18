/*
  PARENT/SUBTASK CHECK — the completion invariant, from both directions.

  The invariant: subtasks finish FIRST, so a parent's done state is a claim about
  its whole subtree. That has two sides, and the bad state arrives from whichever
  one is left open:

    • A parent can't CLOSE over open children. Every path that writes
      `status: "done"` refuses — `completeTask`, a status patch through
      `updateTask`, a drag across the boundary in `moveTask`, and `bulkUpdate`
      (which reports the blocked ids instead of failing the batch).
    • Open work can't be ATTACHED to a closed parent. `createTask` (Add subtask)
      and `moveTask` (re-nest) reopen the parent to Review instead.

  Plus the two rules that keep the tray honest: leaving done un-parks a card from
  DONE THIS WEEK, and `withSubtasks` is the one deliberate way to close a branch.

  Reopening, editing and archiving are NOT blocked, and archived descendants
  don't count.

  Runs against DATABASE_URL on its own throwaway tasks and deletes them after.

    npm run check:parent-done
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { eq, inArray } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { boards, tasks, users } from "../src/lib/db/schema";
import {
  createTask,
  listCanvases,
  updateTask,
  moveTask,
  completeTask,
  bulkUpdate,
  archiveTask,
  deleteTask,
  resolvePlacementSection,
} from "../src/lib/db/service";
import { withLogContext } from "../src/lib/db/log-context";
import { ValidationError } from "../src/lib/api";
import type { TaskStatus } from "../src/lib/types";

const TITLE = "!check-parent-done scratch";
const AUTHOR = "check";

let pass = 0;
const failures: string[] = [];
const scratch: string[] = [];
let ME = "";

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const as = <T>(fn: () => Promise<T>) =>
  withLogContext({ actorId: ME, source: "ui" }, fn);

/** Did `fn` refuse with a ValidationError naming the open subtasks? */
async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof ValidationError ? e.message : `wrong error: ${String(e)}`;
  }
}

/** A scratch task, filed on a real board.
 *
 *  The board matters since TD-136: placement resolves against the task's OWN
 *  project's canvas, reached through its board. A task with no board and no
 *  project has no canvas and therefore no placement — every pin would be null,
 *  and section 5's "it left the done tray" assertion could never distinguish a
 *  move from a no-op. Callers can still override with their own boardId. */
async function mk(
  input: Omit<Parameters<typeof createTask>[0], "title">,
): Promise<string> {
  const t = await as(() =>
    createTask({ boardId: BOARD, ...input, title: TITLE }, ME, AUTHOR),
  );
  scratch.push(t.id);
  return t.id;
}

/** The board scratch tasks are filed on — see `mk`. */
let BOARD = "";

const statusOf = async (id: string): Promise<TaskStatus | null> => {
  const [row] = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, id));
  return (row?.status as TaskStatus) ?? null;
};

const pinOf = async (id: string): Promise<string | null> => {
  const [row] = await db
    .select({ pin: tasks.canvasSectionId })
    .from(tasks)
    .where(eq(tasks.id, id));
  return row?.pin ?? null;
};

/** A parent with one child in `childStatus`. */
async function pair(childStatus: TaskStatus) {
  const parent = await mk({ status: "review" });
  const child = await mk({ parentId: parent, status: childStatus });
  return { parent, child };
}

async function main() {
  const [me] = await db.select({ id: users.id }).from(users).limit(1);
  if (!me) throw new Error("no users in the database");
  ME = me.id;

  // A board whose project HAS a canvas, so placements have somewhere to resolve.
  const [firstCanvas] = await listCanvases();
  if (!firstCanvas) throw new Error("no canvases in the database");
  const [board] = await db
    .select({ id: boards.id })
    .from(boards)
    .where(eq(boards.projectId, firstCanvas.projectId))
    .limit(1);
  if (!board) throw new Error("that project has no boards");
  BOARD = board.id;

  console.log("\n1. every completion path refuses over an open child");
  {
    const { parent } = await pair("review");
    const msg = await refused(() => as(() => completeTask(parent, true, ME, AUTHOR)));
    check("completeTask refuses", msg !== null && msg.includes("subtask"), msg ?? "it completed");
    check("…and the parent is untouched", (await statusOf(parent)) === "review");
  }
  {
    const { parent } = await pair("building");
    const msg = await refused(() =>
      as(() => updateTask(parent, { status: "done" }, ME, AUTHOR)),
    );
    check("updateTask status:'done' refuses", msg !== null, msg ?? "it completed");
  }
  {
    const { parent } = await pair("backlog");
    const msg = await refused(() =>
      as(() => moveTask(parent, { status: "done" }, ME, AUTHOR)),
    );
    check("moveTask across the done boundary refuses", msg !== null, msg ?? "it completed");
  }
  {
    // A grandchild is enough — done is a claim about the whole subtree.
    const parent = await mk({ status: "review" });
    const child = await mk({ parentId: parent, status: "done" });
    await mk({ parentId: child, status: "todo" });
    const msg = await refused(() => as(() => completeTask(parent, true, ME, AUTHOR)));
    check("an open GRANDchild blocks it too", msg !== null, msg ?? "it completed");
  }

  console.log("\n2. what it must NOT block");
  {
    const parent = await mk({ status: "review" });
    await mk({ parentId: parent, status: "done" });
    const t = await as(() => completeTask(parent, true, ME, AUTHOR));
    check("a parent whose children are all done completes", t?.status === "done");
  }
  {
    const leaf = await mk({ status: "review" });
    const t = await as(() => completeTask(leaf, true, ME, AUTHOR));
    check("a childless task completes", t?.status === "done");
  }
  {
    const { parent, child } = await pair("review");
    await as(() => completeTask(child, true, ME, AUTHOR));
    await as(() => archiveTask(child, true, ME, AUTHOR));
    // Archived AND done here; re-open it to prove archived alone is ignored.
    await db.update(tasks).set({ status: "review" }).where(eq(tasks.id, child));
    const t = await as(() => completeTask(parent, true, ME, AUTHOR));
    check("an ARCHIVED open child doesn't block it", t?.status === "done");
  }
  {
    const parent = await mk({ status: "review" });
    await mk({ parentId: parent, status: "done" });
    await as(() => completeTask(parent, true, ME, AUTHOR));
    const t = await as(() => completeTask(parent, false, ME, AUTHOR));
    check("REOPENING a parent is never blocked", t?.status === "todo");
  }
  {
    const { parent } = await pair("review");
    const t = await as(() => updateTask(parent, { title: TITLE }, ME, AUTHOR));
    check("editing a blocked parent still works", t !== null);
  }
  {
    const { parent } = await pair("review");
    const t = await as(() => updateTask(parent, { status: "review" }, ME, AUTHOR));
    check("a no-op status write isn't a completion", t?.status === "review");
  }

  console.log("\n3. bulkUpdate reports the blocked ones, applies the rest");
  {
    const { parent: blocked } = await pair("review");
    const clean = await mk({ status: "review" });
    const res = await as(() =>
      bulkUpdate(ME, [blocked, clean], { status: "done" }, AUTHOR),
    );
    check("the clean task completed", (await statusOf(clean)) === "done");
    check("the blocked parent did not", (await statusOf(blocked)) === "review");
    check(
      "…and is reported in `blocked`, with its open count",
      res.blocked.some((b) => b.id === blocked && b.openCount === 1),
      JSON.stringify(res.blocked),
    );
    check(
      "`skipped` still means \"not yours\" only",
      !res.skipped.includes(blocked),
      JSON.stringify(res.skipped),
    );
    check("`updated` counts only what applied", res.updated === 1, String(res.updated));
  }

  console.log("\n4. the OTHER direction: attaching open work reopens the parent");
  {
    // "Add a subtask…" on a finished task — the everyday path.
    const parent = await mk({ status: "review" });
    await as(() => completeTask(parent, true, ME, AUTHOR));
    const child = await mk({ parentId: parent, status: "backlog" });
    check("createTask under a done parent reopens it", (await statusOf(parent)) === "review");
    check("…and the child is really nested", (await statusOf(child)) === "backlog");
  }
  {
    // Dragging an existing open card onto a done parent.
    const parent = await mk({ status: "review" });
    await as(() => completeTask(parent, true, ME, AUTHOR));
    const loose = await mk({ status: "building" });
    await as(() => moveTask(loose, { parentId: parent }, ME, AUTHOR));
    check("moveTask re-nesting reopens it", (await statusOf(parent)) === "review");
  }
  {
    // Recording work that was already finished changes nothing.
    const parent = await mk({ status: "review" });
    await as(() => completeTask(parent, true, ME, AUTHOR));
    await mk({ parentId: parent, status: "done" });
    check("a DONE child leaves it done", (await statusOf(parent)) === "done");
  }

  console.log("\n5. leaving done un-parks the card");
  {
    const id = await mk({ status: "review" });
    await as(() => completeTask(id, true, ME, AUTHOR));
    await as(() => updateTask(id, { placement: "doneThisWeek" }, ME, AUTHOR));
    const parked = await resolvePlacementSection("doneThisWeek", BOARD);
    check("parked in DONE THIS WEEK first", (await pinOf(id)) === parked, String(await pinOf(id)));
    await as(() => completeTask(id, false, ME, AUTHOR));
    const pin = await pinOf(id);
    // Asserts the RULE, not one lane id: it must leave the done tray. Where it
    // lands depends on the canvas — THIS WEEK when a group is starred, otherwise
    // unpinned (INBOX), which is the fallback that makes the rule work on a
    // canvas that has no THIS WEEK group at all.
    const week = await resolvePlacementSection("thisWeek", BOARD);
    check("reopening takes it OUT of DONE THIS WEEK", pin !== parked, `pin=${pin}`);
    check(
      week !== null
        ? "…and into THIS WEEK, which this canvas has"
        : "…and to INBOX, since this canvas has no THIS WEEK group",
      week !== null ? pin === week : pin === null,
      `pin=${pin} week=${week}`,
    );
  }
  {
    // A pin someone set by hand is a filing decision — reopening doesn't overrule it.
    const id = await mk({ status: "review" });
    await as(() => completeTask(id, true, ME, AUTHOR));
    const own = "!check-pd-section";
    await as(() => updateTask(id, { canvasSectionId: own }, ME, AUTHOR));
    await as(() => completeTask(id, false, ME, AUTHOR));
    check("a hand-set pin survives the reopen", (await pinOf(id)) === own, String(await pinOf(id)));
  }

  console.log("\n6. withSubtasks closes the whole branch");
  {
    const parent = await mk({ status: "review" });
    const child = await mk({ parentId: parent, status: "review" });
    const grandchild = await mk({ parentId: child, status: "building" });
    const t = await as(() =>
      completeTask(parent, true, ME, AUTHOR, { withSubtasks: true }),
    );
    check("the parent completes", t?.status === "done");
    check("the child completes", (await statusOf(child)) === "done");
    check("the grandchild completes", (await statusOf(grandchild)) === "done");
  }
  {
    // Same tree, no flag — still a wall.
    const { parent } = await pair("review");
    const msg = await refused(() => as(() => completeTask(parent, true, ME, AUTHOR)));
    check("without the flag it still refuses", msg !== null, msg ?? "it completed");
  }

  console.log("\n7. the refusal carries what a client needs");
  {
    const { parent, child } = await pair("review");
    let details: Record<string, unknown> | undefined;
    try {
      await as(() => completeTask(parent, true, ME, AUTHOR));
    } catch (e) {
      if (e instanceof ValidationError) details = e.details;
    }
    check("code is `open_subtasks`", details?.code === "open_subtasks", JSON.stringify(details));
    check("it names the task it's about", details?.taskId === parent);
    check(
      "it lists the open subtask ids",
      Array.isArray(details?.openIds) &&
        (details.openIds as string[]).includes(child),
      JSON.stringify(details?.openIds),
    );
  }

  /* ---- cleanup ---- */
  const ids = [...new Set(scratch)];
  // Children first: deleting a parent would orphan/cascade unpredictably.
  for (const id of ids.reverse()) {
    try {
      await as(() => deleteTask(id, ME));
    } catch {
      /* fall through to the hard delete below */
    }
  }
  const left = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids));
  if (left.length) await db.delete(tasks).where(inArray(tasks.id, ids));
  console.log(`\nCleaned up ${ids.length} scratch task(s).`);

  console.log(`\n${pass} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().then(() => process.exit(0));
