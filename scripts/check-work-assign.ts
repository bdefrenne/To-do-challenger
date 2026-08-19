/*
  WORK-ENTRY ASSIGNMENT CHECK — every mutator × every surface.

  The invariant: a task cannot start moving without the board recording who it's
  for. Entering a work status (analyzing/building) from an agent surface — Claude
  over MCP, a bearer-token script, the Telegram bot — records the acting user as
  an assignee; the web UI is the deliberate exception; and taking a handoff
  (mintRef: Copy prompt / lock_task / work_on_task) assigns on EVERY surface.

  The policy lives at one service-layer chokepoint and is read from the ambient
  request context, so what this script really guards is that no mutator drifts
  out of that chokepoint — which is exactly how the original gap happened
  (`assignActor` was an opt-in boolean five call sites forgot to pass).

  Runs against DATABASE_URL and cleans up after itself.

    npm run check:assign            # uses the first user in the roster
    npm run check:assign -- ben@decarbony.com
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { tasks, users } from "../src/lib/db/schema";
import {
  createTask,
  updateTask,
  moveTask,
  bulkUpdate,
  bulkApply,
  mintRef,
  deleteTask,
  purgeTask,
} from "../src/lib/db/service";
import { withLogContext, type LogSource } from "../src/lib/db/log-context";
import type { TaskStatus } from "../src/lib/types";

/** Surfaces where entering a work status must record the actor. Mirrors
 *  ASSIGNING_SOURCES in service.ts — deliberately restated so a change there
 *  has to be a conscious change here too. */
const AGENT_SOURCES: LogSource[] = ["api", "mcp", "telegram"];
const ALL_SOURCES: LogSource[] = ["ui", ...AGENT_SOURCES];

const AUTHOR = "check:assign";
const TITLE = "[check:assign] scratch — safe to delete";

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

/** Run `fn` as if the request had arrived on `source`. */
const as = <T>(source: LogSource, fn: () => Promise<T>) =>
  withLogContext({ actorId: ME, source }, fn);

/** A fresh unassigned task. Created as "ui" so creation itself never assigns. */
async function newTask(status: TaskStatus = "todo"): Promise<string> {
  const t = await as("ui", () =>
    createTask({ title: TITLE, status }, ME, AUTHOR),
  );
  scratch.push(t.id);
  return t.id;
}

async function assigneesOf(id: string): Promise<string[]> {
  const [row] = await db
    .select({ assigneeIds: tasks.assigneeIds })
    .from(tasks)
    .where(eq(tasks.id, id));
  return row?.assigneeIds ?? [];
}

const assigned = async (id: string) => (await assigneesOf(id)).includes(ME);

let ME = "";
let OTHER: string | null = null;

/* Each mutator, reduced to "drive this task into `building`". */
const MUTATORS: { name: string; drive: (id: string) => Promise<unknown> }[] = [
  {
    name: "updateTask",
    drive: (id) => updateTask(id, { status: "building" }, ME, AUTHOR),
  },
  {
    name: "moveTask",
    drive: (id) => moveTask(id, { status: "building" }, ME, AUTHOR),
  },
  {
    name: "bulkUpdate",
    drive: (id) => bulkUpdate(ME, [id], { status: "building" }, AUTHOR),
  },
  {
    name: "bulkApply",
    drive: (id) =>
      bulkApply(ME, [{ op: "update", id, patch: { status: "building" } }], AUTHOR),
  },
];

/** Cleanup means GONE. DELETE is a soft delete now (TD2-196) — a scratch task
 *  removed with `deleteTask` alone would sit in the Trash after every run — so
 *  the checks bin it and then purge it, which is also the two-step the app makes
 *  a person take. */
async function scrub(id: string): Promise<void> {
  await deleteTask(id, ME);
  await purgeTask(id, ME);
}

async function main() {
  const wanted = process.argv[2];
  const roster = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users);
  if (!roster.length) throw new Error("No users in the roster.");
  const me = wanted
    ? roster.find((u) => u.email.toLowerCase() === wanted.toLowerCase())
    : roster[0];
  if (!me) throw new Error(`No user with email ${wanted}.`);
  ME = me.id;
  OTHER = roster.find((u) => u.id !== ME)?.id ?? null;
  console.log(`Acting as ${me.name} <${me.email}>\n`);

  /* ---- 1. Status mutators × surfaces ---------------------------------- */
  for (const m of MUTATORS) {
    for (const source of ALL_SOURCES) {
      const id = await newTask();
      await as(source, () => m.drive(id) as Promise<unknown>);
      const got = await assigned(id);
      const want = AGENT_SOURCES.includes(source);
      check(
        `${m.name} → building via ${source}: ${want ? "assigns" : "does NOT assign"}`,
        got === want,
        `assignees=${JSON.stringify(await assigneesOf(id))}`,
      );
    }
  }

  /* ---- 2. createTask born into a work status -------------------------- */
  for (const source of ALL_SOURCES) {
    const t = await as(source, () =>
      createTask({ title: TITLE, status: "building" }, ME, AUTHOR),
    );
    scratch.push(t.id);
    const want = AGENT_SOURCES.includes(source);
    check(
      `createTask born in building via ${source}: ${want ? "assigns" : "does NOT assign"}`,
      (await assigned(t.id)) === want,
    );
  }

  /* ---- 3. mintRef — the handoff, assigns on EVERY surface ------------- */
  for (const source of ALL_SOURCES) {
    const id = await newTask();
    await as(source, () => mintRef(id, ME, AUTHOR));
    check(
      `mintRef (unlocked) via ${source}: assigns`,
      await assigned(id),
      `assignees=${JSON.stringify(await assigneesOf(id))}`,
    );
  }

  // The regression that mattered most: an ALREADY-LOCKED task used to
  // short-circuit with no write at all, so a second Copy prompt assigned nobody.
  {
    const id = await newTask();
    await as("ui", () => mintRef(id, ME, AUTHOR)); // locks + assigns
    await as("ui", () =>
      updateTask(id, { assigneeIds: [] }, ME, AUTHOR),
    ); // clear, ref stays locked
    check("mintRef precondition: ref is locked and assignees cleared", !(await assigned(id)));
    await as("ui", () => mintRef(id, ME, AUTHOR));
    check("mintRef on an ALREADY-LOCKED task still assigns", await assigned(id));
    // And it stays idempotent — no duplicate entry on a third click.
    await as("ui", () => mintRef(id, ME, AUTHOR));
    const list = await assigneesOf(id);
    check(
      "mintRef is idempotent (no duplicate assignee)",
      list.filter((a) => a === ME).length === 1,
      `assignees=${JSON.stringify(list)}`,
    );
  }

  /* ---- 4. Merge, never clobber ---------------------------------------- */
  if (OTHER) {
    const id = await newTask();
    await as("ui", () => updateTask(id, { assigneeIds: [OTHER!] }, ME, AUTHOR));
    await as("mcp", () => updateTask(id, { status: "building" }, ME, AUTHOR));
    const list = await assigneesOf(id);
    check(
      "existing assignee is kept when the actor joins",
      list.includes(OTHER!) && list.includes(ME),
      `assignees=${JSON.stringify(list)}`,
    );
  } else {
    console.log("  – skipped merge check (roster has only one user)");
  }

  /* ---- 5. Resting statuses don't claim -------------------------------- */
  for (const status of ["analyzed", "review"] as TaskStatus[]) {
    const id = await newTask();
    await as("mcp", () => updateTask(id, { status }, ME, AUTHOR));
    check(`${status} via mcp does NOT assign (not active work)`, !(await assigned(id)));
  }

  /* ---- 6. No ambient context (seed/backfill scripts) → no assignment -- */
  {
    const t = await createTask({ title: TITLE, status: "todo" }, ME, AUTHOR);
    scratch.push(t.id);
    await updateTask(t.id, { status: "building" }, ME, AUTHOR); // no withLogContext
    check("outside any request context: does NOT assign (fails safe)", !(await assigned(t.id)));
  }

  /* ---- 7. bulkUpdate merges PER ROW, not one shared list -------------- */
  if (OTHER) {
    const a = await newTask();
    const b = await newTask();
    await as("ui", () => updateTask(a, { assigneeIds: [OTHER!] }, ME, AUTHOR));
    await as("mcp", () => bulkUpdate(ME, [a, b], { status: "building" }, AUTHOR));
    const [la, lb] = [await assigneesOf(a), await assigneesOf(b)];
    check(
      "bulkUpdate keeps each row's own assignees while adding the actor",
      la.includes(OTHER!) && la.includes(ME) && lb.length === 1 && lb.includes(ME),
      `a=${JSON.stringify(la)} b=${JSON.stringify(lb)}`,
    );
  }

  // An explicit list in the same patch still gets the actor merged in.
  if (OTHER) {
    const id = await newTask();
    await as("mcp", () =>
      bulkUpdate(ME, [id], { status: "building", assigneeIds: [OTHER!] }, AUTHOR),
    );
    const list = await assigneesOf(id);
    check(
      "bulkUpdate with an explicit assignee list also merges the actor",
      list.includes(OTHER!) && list.includes(ME),
      `assignees=${JSON.stringify(list)}`,
    );
  }

  /* ---- 8. The assignment is explicable on the timeline ---------------- */
  {
    const id = await newTask();
    await as("mcp", () => updateTask(id, { status: "building" }, ME, AUTHOR));
    const { getTask } = await import("../src/lib/db/service");
    const detail = await getTask(id, ME);
    check(
      "activity trail explains the implicit assignment",
      (detail?.logs ?? []).some((l) => l.message.includes("Assigned to")),
      JSON.stringify((detail?.logs ?? []).map((l) => l.message)),
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
        /* best effort — a leftover is titled "[check:assign] scratch" */
      }
    }
    console.error(e);
    process.exit(1);
  });
