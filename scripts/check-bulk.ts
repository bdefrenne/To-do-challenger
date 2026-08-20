/*
  BULK + CANVAS-PIN CHECK — the two silent-data-loss paths behind TD-45/TD-46.

  Both bugs shared a shape: a write didn't land, and nothing said so.

  TD-45 — `moveTask` CLEARS a task's canvas Section pin when the board changes,
  unless the call states a pin. The canvas wrote the pin in one bulk op and moved
  the board in the next, so the move undid the pin and a cross-board drop landed
  in the INBOX lane. What's guarded here is the resolution table itself: explicit
  pin survives a board change, omitted pin still clears (the stale-pin rule is
  deliberate and must not regress), explicit null unpins.

  TD-46 — `bulkApply` is best-effort: ops fail individually and anything past
  MAX_BULK_OPS is dropped with NO results entry at all. Clients read `results`
  positionally to pair created tasks back to rows, so what's guarded here is that
  results stay index-aligned with the ops even when one fails, and that going over
  the cap really does drop ops silently — which is why the client chunks.

  TD2-188 — a create says WHERE the new task goes, and that has to survive the
  trip. The outline computes a fractional key between the row's neighbours (see
  `siblingPositionAt`, checked pure in check:outline) and sends it on the create
  op; it was stripped by the request schema and then overwritten by `nextPosition`,
  so every line opened mid-list was appended and the row — with the caret in it —
  jumped to the end of the group on the next refetch. Guarded here at both layers,
  along with the append default nothing else may lose.

  TD2-200 — the send-arrows name an END of a lane ("top" = do it next, "bottom" =
  behind the rest) and the server turns that into a position, so the keypress
  means the same thing on the canvas, off it, and over MCP. Guarded here because
  the rule only has to hold where it's hard: a lane's positions routinely TIE, and
  the lane is scoped by board as well as by pin.

  Runs against DATABASE_URL, creates its own scratch tasks, cleans up after
  itself. The over-cap case issues MAX_BULK_OPS+ failing ops, so it takes a while.

    npm run check:bulk
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { tasks, users } from "../src/lib/db/schema";
import {
  createTask,
  moveTask,
  deleteTask,
  purgeTask,
  bulkApply,
  listProjects,
} from "../src/lib/db/service";
import { MAX_BULK_OPS } from "../src/lib/bulk";
import { createTaskSchema, moveTaskSchema, updateTaskSchema } from "../src/lib/api";
import { compareTaskOrder } from "../src/lib/task-order";

const AUTHOR = "check:bulk";
const TITLE = "[check:bulk] scratch — safe to delete";

let pass = 0;
const failures: string[] = [];
const scratch: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let ME = "";

/** Section pins are plain ids — `moveTask` doesn't check the node exists — so a
 *  synthetic one keeps this hermetic: no canvas rows created or touched. */
const SECTION_A = "check-bulk-section-a";
const SECTION_B = "check-bulk-section-b";

async function newTask(boardId: string, canvasSectionId: string | null) {
  const t = await createTask({ title: TITLE, boardId, canvasSectionId }, ME, AUTHOR);
  scratch.push(t.id);
  return t.id;
}

/** A task's stored position — the column the create is supposed to set. */
async function positionOf(id: string): Promise<number | undefined> {
  const [row] = await db
    .select({ position: tasks.position })
    .from(tasks)
    .where(eq(tasks.id, id));
  return row?.position;
}

/** A parent's children in the order every surface renders them (position, then
 *  createdAt, then id — see `compareTaskOrder`). Titles, so a failure reads. */
async function childOrder(parentId: string): Promise<string[]> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      position: tasks.position,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(eq(tasks.parentId, parentId));
  return rows
    .map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
    .sort(compareTaskOrder)
    .map((r) => r.title);
}

async function pinOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ pin: tasks.canvasSectionId })
    .from(tasks)
    .where(eq(tasks.id, id));
  return row?.pin ?? null;
}

/** Cleanup means GONE. DELETE is a soft delete now (TD2-196) — a scratch task
 *  removed with `deleteTask` alone would sit in the Trash after every run — so
 *  the checks bin it and then purge it, which is also the two-step the app makes
 *  a person take. */
async function scrub(id: string): Promise<void> {
  await deleteTask(id, ME);
  await purgeTask(id, ME);
}

async function main() {
  const [me] = await db.select({ id: users.id }).from(users).limit(1);
  if (!me) throw new Error("no users in the roster");
  ME = me.id;

  const allBoards = (await listProjects(ME)).flatMap((p) => p.boards ?? []);
  if (allBoards.length < 2) throw new Error("need at least 2 boards to test a cross-board move");
  const [boardA, boardB] = allBoards;

  /* ---- TD-45: the pin resolution table ------------------------------- */
  console.log("\nTD-45 — canvas pin across a board change");
  {
    const id = await newTask(boardA.id, SECTION_A);
    await moveTask(id, { boardId: boardB.id, canvasSectionId: SECTION_B }, ME, AUTHOR);
    const pin = await pinOf(id);
    check(
      "an explicit pin survives a board change (the bug)",
      pin === SECTION_B,
      `pin=${pin}`,
    );
  }
  {
    const id = await newTask(boardA.id, SECTION_A);
    await moveTask(id, { boardId: boardB.id }, ME, AUTHOR);
    const pin = await pinOf(id);
    check("an OMITTED pin still clears on a board change", pin === null, `pin=${pin}`);
  }
  {
    const id = await newTask(boardA.id, SECTION_A);
    await moveTask(id, { boardId: boardB.id, canvasSectionId: null }, ME, AUTHOR);
    check("an explicit null unpins", (await pinOf(id)) === null);
  }
  {
    // The everyday case: a reorder inside one section must not disturb the pin.
    const id = await newTask(boardA.id, SECTION_A);
    await moveTask(id, { position: 7 }, ME, AUTHOR);
    const pin = await pinOf(id);
    check("a pure re-sort leaves the pin alone", pin === SECTION_A, `pin=${pin}`);
  }

  /* ---- TD-45: the BATCH SHAPE the canvas actually sends --------------- */
  // The checks above prove `moveTask` honours an explicit pin. These prove the
  // canvas asks for it the right way — the bug was never in the resolution rule,
  // it was in splitting the intent across two ops so the second undid the first.
  console.log("\nTD-45 — the canvas drop batch, end to end");
  {
    // The OLD shape, kept as a regression witness: pin in an `update`, board in a
    // following `move`. The move sees boardChanged and clears the pin.
    const id = await newTask(boardA.id, null);
    await bulkApply(
      ME,
      [
        { op: "update", id, patch: { canvasSectionId: SECTION_B } },
        { op: "move", id, target: { boardId: boardB.id, position: 0 } },
      ],
      AUTHOR,
    );
    const pin = await pinOf(id);
    check(
      "old batch shape (update-then-move) loses the pin — the bug",
      pin === null,
      `pin=${pin}`,
    );
  }
  {
    // The shape the client sends now: one op carrying the whole intent.
    const id = await newTask(boardA.id, null);
    await bulkApply(
      ME,
      [
        {
          op: "move",
          id,
          target: { boardId: boardB.id, position: 0, canvasSectionId: SECTION_B },
        },
      ],
      AUTHOR,
    );
    const pin = await pinOf(id);
    check(
      "new batch shape pins the card in the section it was dropped on",
      pin === SECTION_B,
      `pin=${pin}`,
    );
  }
  {
    // Dropping into an INBOX lane means "unpin", and must stay unpinned.
    const id = await newTask(boardA.id, SECTION_A);
    await bulkApply(
      ME,
      [{ op: "move", id, target: { boardId: boardB.id, position: 0, canvasSectionId: null } }],
      AUTHOR,
    );
    check("dropping into an INBOX lane leaves it unpinned", (await pinOf(id)) === null);
  }

  /* ---- TD2-188: a create carries WHERE the line was opened ------------ */
  console.log("\nTD2-188 — createTask honours the position it was given");
  {
    // The layer that dropped it first: zod strips unknown keys, so a schema
    // without `position` loses it before anyone can honour it.
    const parsed = createTaskSchema.safeParse({ title: TITLE, position: 10.5 });
    check(
      "the request schema lets `position` through (it was silently stripped)",
      parsed.success && parsed.data.position === 10.5,
      JSON.stringify(parsed.success ? parsed.data : parsed.error.issues),
    );
  }
  {
    const t = await createTask({ title: TITLE, boardId: boardA.id, position: 10.5 }, ME, AUTHOR);
    scratch.push(t.id);
    const p = await positionOf(t.id);
    check(
      "an explicit fractional key is stored verbatim (not rounded, not replaced)",
      p === 10.5,
      `position=${p}`,
    );
  }
  {
    // The default nothing else may lose: no position asked for → end of the
    // (status, parent) group. Scoped to a scratch parent so the group is ours.
    const parent = await newTask(boardA.id, null);
    const first = await createTask(
      { title: `${TITLE} first`, boardId: boardA.id, parentId: parent, position: 5 },
      ME,
      AUTHOR,
    );
    scratch.push(first.id);
    const appended = await createTask(
      { title: `${TITLE} appended`, boardId: boardA.id, parentId: parent },
      ME,
      AUTHOR,
    );
    scratch.push(appended.id);
    const p = await positionOf(appended.id);
    check("an omitted position still appends (max + 1)", p === 6, `position=${p}`);
  }
  {
    // The reported bug, end to end: a task with three subtasks, then a fourth
    // created FIRST — which is what Shift+Tab out of a description asks for.
    const parent = await newTask(boardA.id, null);
    for (const [i, name] of ["sous task", "subtask", "sub"].entries()) {
      const kid = await createTask(
        { title: name, boardId: boardA.id, parentId: parent, position: i + 1 },
        ME,
        AUTHOR,
      );
      scratch.push(kid.id);
    }
    const popped = await createTask(
      { title: "desc", boardId: boardA.id, parentId: parent, position: 0 },
      ME,
      AUTHOR,
    );
    scratch.push(popped.id);
    check(
      "a line popped out of a description lands FIRST, not last (the bug)",
      JSON.stringify(await childOrder(parent)) ===
        JSON.stringify(["desc", "sous task", "subtask", "sub"]),
      JSON.stringify(await childOrder(parent)),
    );
    // …and the mid-list case: an Enter split between two siblings.
    const split = await createTask(
      { title: "split", boardId: boardA.id, parentId: parent, position: 1.5 },
      ME,
      AUTHOR,
    );
    scratch.push(split.id);
    check(
      "a midpoint key lands between its neighbours",
      JSON.stringify(await childOrder(parent)) ===
        JSON.stringify(["desc", "sous task", "split", "subtask", "sub"]),
      JSON.stringify(await childOrder(parent)),
    );
  }
  {
    // The guard: a key computed among someone's children means nothing in the
    // root group, so a parent that doesn't resolve falls back to appending
    // rather than dropping the task into the middle of the roots.
    const t = await createTask(
      { title: TITLE, boardId: boardA.id, parentId: "no-such-parent", position: 0 },
      ME,
      AUTHOR,
    );
    scratch.push(t.id);
    const p = await positionOf(t.id);
    check(
      "a position for a parent that didn't resolve is ignored, not applied at root",
      t.parentId === null && p !== 0,
      `parentId=${t.parentId} position=${p}`,
    );
  }
  {
    // The shape the outline actually sends: one bulk create per row, carrying the
    // parent and the key together.
    const parent = await newTask(boardA.id, null);
    const res = await bulkApply(
      ME,
      [
        { op: "create", input: { title: "first line", boardId: boardA.id, parentId: parent, position: 1 } },
        { op: "create", input: { title: "opened above it", boardId: boardA.id, parentId: parent, position: 0 } },
      ],
      AUTHOR,
    );
    for (const r of res.results) if (r.ok && r.id) scratch.push(r.id);
    check(
      "the outline's own batch shape keeps the order it asked for",
      JSON.stringify(await childOrder(parent)) ===
        JSON.stringify(["opened above it", "first line"]),
      JSON.stringify(await childOrder(parent)),
    );
  }

  /* ---- TD2-200: which END of a lane a send-arrow lands at ------------- */
  // The send-arrows name an END ("top" = do it next, "bottom" = behind the rest)
  // and the SERVER turns that into a position — that's what makes the same
  // keypress mean the same thing on the canvas, off it, and over MCP. The rule
  // has to survive a lane whose positions TIE, which is the normal state of a
  // lane: `position` is minted per (status, parent) and never renumbered, so a
  // mixed-status lane routinely holds several cards claiming the same number.
  console.log("\nTD2-200 — send-arrows land at an END of the lane");
  {
    // Three cards in one lane, all on position 0 — the tie that makes an
    // interpolated midpoint useless (the midpoint of 0 and 0 IS 0).
    const lane = "check-bulk-section-end";
    const ids: string[] = [];
    for (const n of ["tied a", "tied b", "tied c"]) {
      const t = await createTask(
        { title: `${TITLE} ${n}`, boardId: boardA.id, canvasSectionId: lane, position: 0 },
        ME,
        AUTHOR,
      );
      scratch.push(t.id);
      ids.push(t.id);
    }
    const sent = await newTask(boardA.id, null);

    await moveTask(sent, { canvasSectionId: lane, end: "top" }, ME, AUTHOR);
    const top = await positionOf(sent);
    check(
      "end:'top' lands strictly before a lane of tied positions",
      top !== undefined && top < 0,
      `position=${top}`,
    );
    check("…and the pin came along", (await pinOf(sent)) === lane);

    await moveTask(sent, { canvasSectionId: lane, end: "bottom" }, ME, AUTHOR);
    const bottom = await positionOf(sent);
    check(
      "end:'bottom' on a card ALREADY in the lane re-ends it (→ after ↑)",
      bottom !== undefined && bottom > 0,
      `position=${bottom}`,
    );
    check(
      "…and it doesn't count its own position, so it clears the lane it's in",
      bottom !== undefined && bottom === 1,
      `position=${bottom}`,
    );

    // An explicit position is the stricter answer — a drag knows its exact index.
    await moveTask(sent, { canvasSectionId: lane, end: "top", position: 42 }, ME, AUTHOR);
    check("an explicit position wins over an end", (await positionOf(sent)) === 42);

    // The lane is per BOARD as well as per pin: another board's cards in a
    // same-named section must not drag the ends around.
    const stranger = await createTask(
      { title: `${TITLE} other board`, boardId: boardB.id, canvasSectionId: lane, position: 900 },
      ME,
      AUTHOR,
    );
    scratch.push(stranger.id);
    const again = await newTask(boardA.id, null);
    await moveTask(again, { canvasSectionId: lane, end: "bottom" }, ME, AUTHOR);
    const p = await positionOf(again);
    check(
      "the other board's cards aren't part of this lane's run",
      p !== undefined && p < 900,
      `position=${p}`,
    );
  }
  {
    // The TD2-188 lesson applied to this field: a zod schema that silently strips
    // `end` fails nowhere else — the arrow would just file the card and leave its
    // position wherever it was.
    const parsed = moveTaskSchema.safeParse({ placement: "thisWeek", end: "top" });
    check(
      "the move request schema keeps `end`",
      parsed.success && parsed.data.end === "top",
      JSON.stringify(parsed.success ? parsed.data : parsed.error.issues),
    );
    const bad = moveTaskSchema.safeParse({ end: "middle" });
    check("…and rejects an end that isn't an end", !bad.success);
    const upd = updateTaskSchema.safeParse({ placement: "backlog", end: "bottom" });
    check(
      "the update request schema keeps `end` too (the MCP path)",
      upd.success && upd.data.end === "bottom",
      JSON.stringify(upd.success ? upd.data : upd.error.issues),
    );
  }

  /* ---- TD-46: results alignment and the silent cap -------------------- */
  console.log("\nTD-46 — bulk results contract");
  {
    const a = await newTask(boardA.id, null);
    const b = await newTask(boardA.id, null);
    const res = await bulkApply(
      ME,
      [
        { op: "move", id: a, target: { position: 11 } },
        { op: "move", id: "no-such-task-id", target: { position: 12 } },
        { op: "move", id: b, target: { position: 13 } },
      ],
      AUTHOR,
    );
    check("one result per op", res.results.length === 3, `len=${res.results.length}`);
    check(
      "the failed op keeps its slot, so results stay index-aligned",
      res.results[0]?.ok === true &&
        res.results[1]?.ok === false &&
        res.results[2]?.ok === true,
      JSON.stringify(res.results.map((r) => r.ok)),
    );
    const [rowA] = await db
      .select({ position: tasks.position })
      .from(tasks)
      .where(eq(tasks.id, a));
    const [rowB] = await db
      .select({ position: tasks.position })
      .from(tasks)
      .where(eq(tasks.id, b));
    check(
      "the ops either side of the failure still applied",
      rowA?.position === 11 && rowB?.position === 13,
      `a=${rowA?.position} b=${rowB?.position}`,
    );
  }
  {
    // Over the cap, the tail is dropped with no results entry — a caller that
    // trusts `results.length` cannot tell. This is what the client chunks around.
    const over = 5;
    const ops = Array.from({ length: MAX_BULK_OPS + over }, (_, i) => ({
      op: "delete" as const,
      id: `no-such-task-${i}`,
    }));
    console.log(`  … issuing ${ops.length} ops to prove the cap drops the tail`);
    const res = await bulkApply(ME, ops, AUTHOR);
    check("over-cap batch reports truncated", res.truncated === true);
    check(
      `dropped ops get NO results entry (${MAX_BULK_OPS} of ${ops.length})`,
      res.results.length === MAX_BULK_OPS,
      `len=${res.results.length}`,
    );
  }
}

main()
  .then(async () => {
    for (const id of scratch) await scrub(id);
    console.log(
      `\nCleaned up ${scratch.length} scratch task(s).\n` +
        `${pass} passed, ${failures.length} failed.`,
    );
    if (failures.length) {
      console.error("\nFailures:\n" + failures.map((f) => `  • ${f}`).join("\n"));
      process.exit(1);
    }
  })
  .catch(async (e) => {
    for (const id of scratch) {
      try {
        await scrub(id);
      } catch {
        /* best effort — a leftover is titled "[check:bulk] scratch" */
      }
    }
    console.error(e);
    process.exit(1);
  });
