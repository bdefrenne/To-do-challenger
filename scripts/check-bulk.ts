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
  bulkApply,
  listProjects,
} from "../src/lib/db/service";
import { MAX_BULK_OPS } from "../src/lib/bulk";

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

async function pinOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ pin: tasks.canvasSectionId })
    .from(tasks)
    .where(eq(tasks.id, id));
  return row?.pin ?? null;
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
    for (const id of scratch) await deleteTask(id, ME);
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
        await deleteTask(id, ME);
      } catch {
        /* best effort — a leftover is titled "[check:bulk] scratch" */
      }
    }
    console.error(e);
    process.exit(1);
  });
