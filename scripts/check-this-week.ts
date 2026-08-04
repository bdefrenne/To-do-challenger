/*
  THIS WEEK PLACEMENT CHECK — every mutator × every surface.

  The invariant: a task an agent files as "this week" lands on the flagged
  section_group's section for its own board; everything else stays unpinned and
  surfaces in INBOX. And, like work-entry assignment, the STATUS-IMPLIED move is
  an agent-surface-only implicit write — the web UI never re-files a card behind
  the user's back.

  Runs against DATABASE_URL on its OWN throwaway group + lane, then deletes them
  along with every scratch task. It deliberately does NOT flag one of your real
  groups: canvas nodes live in Liveblocks storage, so an open canvas would
  persist its own copy of `data` right over a flag written in SQL. (Which is why
  the ★ in the group header — a storage write — is the only way to set it for
  real.) A node this script invents isn't in any client's storage, so nothing
  fights it.

    npm run check:this-week
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { eq, inArray, like, or } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { canvasNodes, tasks, users } from "../src/lib/db/schema";
import {
  createTask,
  updateTask,
  moveTask,
  bulkUpdate,
  deleteTask,
  resolveThisWeekSection,
  getCanvas,
  listCanvases,
} from "../src/lib/db/service";
import {
  boardsNeedingWeekLane,
  thisWeekGroupId,
  weekLaneId,
  isThisWeekGroup,
} from "../src/lib/sections";
import { withLogContext, type LogSource } from "../src/lib/db/log-context";
import type { CanvasNode, Task } from "../src/lib/types";

const AUTHOR = "check:this-week";
const TITLE = "[check:this-week] scratch — safe to delete";

/** Our throwaway nodes. Prefixed so a leftover is obvious and easy to sweep. */
const GROUP_ID = "check-tw-group";
const LANE_ID = "check-tw-lane";

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

const as = <T>(source: LogSource, fn: () => Promise<T>) =>
  withLogContext({ actorId: ME, source }, fn);

const pinOf = async (id: string): Promise<string | null> => {
  const [row] = await db
    .select({ canvasSectionId: tasks.canvasSectionId })
    .from(tasks)
    .where(eq(tasks.id, id));
  return row?.canvasSectionId ?? null;
};

async function mk(
  input: Omit<Parameters<typeof createTask>[0], "title">,
  source: LogSource = "ui",
): Promise<string> {
  const t = await as(source, () => createTask({ ...input, title: TITLE }, ME, AUTHOR));
  scratch.push(t.id);
  return t.id;
}

/** A minimal stand-in node — only the fields the placement helpers read. */
const stubSection = (id: string, data: Record<string, unknown>): CanvasNode => ({
  id,
  kind: "section",
  content: "",
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  color: null,
  position: 0,
  data,
});

async function main() {
  const roster = await db.select({ id: users.id, email: users.email, name: users.name }).from(users);
  ME = roster.find((u) => u.email === "ben@decarbony.com")?.id ?? roster[0].id;

  const [canvas] = await listCanvases();
  const full = await getCanvas(canvas.id);
  if (!full) throw new Error("no canvas");
  const nodes = full.nodes as CanvasNode[];

  // Two real boards: one our group will have a section for, one it won't.
  const boardIds = [
    ...new Set(nodes.map((n) => n.data?.boardId as string | undefined)),
  ].filter((b): b is string => !!b);
  if (boardIds.length < 2) throw new Error("need two boards represented on the canvas");
  const [coveredBoard, uncoveredBoard] = boardIds;

  console.log(`Canvas “${canvas.name}” (${canvas.id})`);
  console.log(`  covered board   ${coveredBoard} → our lane ${LANE_ID}`);
  console.log(`  uncovered board ${uncoveredBoard}\n`);

  /* ---- 0. Nothing flagged: everything stays in INBOX ------------------- */
  check(
    "no flagged group: resolveThisWeekSection returns null",
    (await resolveThisWeekSection(coveredBoard)) === null,
  );
  {
    const id = await mk({ boardId: coveredBoard, thisWeek: true });
    check("no flagged group: thisWeek:true still leaves the task unpinned", (await pinOf(id)) === null);
  }

  /* ---- Our own flagged group + one member section ---------------------- */
  await db.insert(canvasNodes).values([
    {
      id: GROUP_ID,
      userId: ME,
      canvasId: canvas.id,
      kind: "section_group",
      content: "[check:this-week] group",
      data: { thisWeek: true, layout: "portrait" },
    },
    {
      id: LANE_ID,
      userId: ME,
      canvasId: canvas.id,
      kind: "section",
      content: "[check:this-week] lane",
      data: { groupId: GROUP_ID, boardId: coveredBoard },
    },
  ]);
  console.log("Created a throwaway THIS WEEK group + lane.\n");

  /* ---- 1. Resolution --------------------------------------------------- */
  check(
    "a board the group covers resolves to that existing section",
    (await resolveThisWeekSection(coveredBoard)) === LANE_ID,
    `got ${await resolveThisWeekSection(coveredBoard)}`,
  );
  check(
    "a board it doesn't cover resolves to the DERIVED lane id",
    (await resolveThisWeekSection(uncoveredBoard)) === weekLaneId(GROUP_ID, uncoveredBoard),
    `got ${await resolveThisWeekSection(uncoveredBoard)}`,
  );
  check(
    "a board-less task resolves to the derived 'noboard' lane",
    (await resolveThisWeekSection(null)) === weekLaneId(GROUP_ID, null),
  );

  /* ---- 2. The client half: which lanes need materialising -------------- */
  {
    const groupNode: CanvasNode = {
      ...stubSection(GROUP_ID, { thisWeek: true }),
      kind: "section_group",
    };
    const scene = [...nodes, groupNode, stubSection(LANE_ID, { groupId: GROUP_ID, boardId: coveredBoard })];
    check("thisWeekGroupId finds the flagged group", thisWeekGroupId(scene) === GROUP_ID);
    check("isThisWeekGroup is true only for it", scene.filter(isThisWeekGroup).length === 1);

    const pinned = weekLaneId(GROUP_ID, uncoveredBoard);
    const task = { id: "t1", parentId: null, boardId: uncoveredBoard };
    const map = { t1: { canvasSectionId: pinned } as Task };
    const needed = boardsNeedingWeekLane(scene, [task], map);
    check(
      "boardsNeedingWeekLane asks for exactly the lane the server pinned to",
      needed.size === 1 && needed.has(uncoveredBoard),
      `got ${JSON.stringify([...needed])}`,
    );
    check(
      "…and stops asking once that lane exists",
      boardsNeedingWeekLane([...scene, stubSection(pinned, { groupId: GROUP_ID })], [task], map).size === 0,
    );
    check(
      "a pin to an existing section is never mistaken for a pending lane",
      boardsNeedingWeekLane(scene, [{ id: "t2", parentId: null, boardId: coveredBoard }], {
        t2: { canvasSectionId: LANE_ID } as Task,
      }).size === 0,
    );
    check(
      "no flagged group ⇒ nothing to materialise",
      boardsNeedingWeekLane(nodes, [task], map).size === 0,
    );
  }

  /* ---- 3. createTask --------------------------------------------------- */
  {
    const id = await mk({ boardId: coveredBoard, thisWeek: true });
    check("createTask thisWeek:true → the group's section for that board", (await pinOf(id)) === LANE_ID);
  }
  {
    const id = await mk({ boardId: uncoveredBoard, thisWeek: true });
    check(
      "createTask thisWeek:true on an uncovered board → derived lane",
      (await pinOf(id)) === weekLaneId(GROUP_ID, uncoveredBoard),
    );
  }
  {
    const id = await mk({ boardId: coveredBoard });
    check("createTask (default) → unpinned, i.e. INBOX", (await pinOf(id)) === null);
  }
  {
    const id = await mk({ boardId: coveredBoard, status: "building", thisWeek: false }, "mcp");
    check("createTask thisWeek:false overrides the status rule", (await pinOf(id)) === null);
  }
  {
    const id = await mk({ boardId: coveredBoard, status: "analyzing" }, "mcp");
    check("createTask born in analyzing via mcp → THIS WEEK", (await pinOf(id)) === LANE_ID);
  }
  {
    const id = await mk({ boardId: coveredBoard, status: "analyzing" }, "ui");
    check("createTask born in analyzing via the web UI → INBOX (no implicit re-file)", (await pinOf(id)) === null);
  }
  {
    const id = await mk({ boardId: coveredBoard, status: "done" }, "mcp");
    check("createTask born done via mcp → INBOX (done is not 'this week')", (await pinOf(id)) === null);
  }

  /* ---- 4. updateTask --------------------------------------------------- */
  {
    const id = await mk({ boardId: coveredBoard });
    await as("mcp", () => updateTask(id, { thisWeek: true }, ME, AUTHOR));
    check("updateTask thisWeek:true moves it to THIS WEEK", (await pinOf(id)) === LANE_ID);
    await as("mcp", () => updateTask(id, { thisWeek: false }, ME, AUTHOR));
    check("updateTask thisWeek:false sends it back to INBOX", (await pinOf(id)) === null);
  }
  {
    const id = await mk({ boardId: coveredBoard });
    await as("mcp", () => updateTask(id, { status: "analyzing" }, ME, AUTHOR));
    check("updateTask → analyzing via mcp files an UNPINNED task", (await pinOf(id)) === LANE_ID);
  }
  {
    const id = await mk({ boardId: coveredBoard });
    await as("ui", () => updateTask(id, { status: "analyzing" }, ME, AUTHOR));
    check("updateTask → analyzing via the web UI does NOT re-file it", (await pinOf(id)) === null);
  }
  {
    // A card the user filed by hand must not be yanked out of its section.
    const elsewhere = nodes.find(
      (n) => n.kind === "section" && n.data?.inbox !== true,
    )!.id;
    const id = await mk({ boardId: coveredBoard, canvasSectionId: elsewhere });
    await as("mcp", () => updateTask(id, { status: "building" }, ME, AUTHOR));
    check("a hand-filed task keeps its own section when work starts", (await pinOf(id)) === elsewhere);
    await as("mcp", () => updateTask(id, { thisWeek: true }, ME, AUTHOR));
    check("…but an EXPLICIT thisWeek:true still moves it", (await pinOf(id)) === LANE_ID);
  }
  {
    const id = await mk({ boardId: coveredBoard });
    await as("mcp", () => updateTask(id, { status: "todo" }, ME, AUTHOR));
    check("a non-work status leaves placement alone", (await pinOf(id)) === null);
  }

  /* ---- 5. moveTask ----------------------------------------------------- */
  {
    const id = await mk({ boardId: coveredBoard });
    await as("mcp", () => moveTask(id, { status: "building" }, ME, AUTHOR));
    check("moveTask → building via mcp files it on THIS WEEK", (await pinOf(id)) === LANE_ID);
  }
  {
    const id = await mk({ boardId: coveredBoard });
    await as("ui", () => moveTask(id, { status: "building" }, ME, AUTHOR));
    check("moveTask → building via the web UI does NOT (a Kanban drag)", (await pinOf(id)) === null);
  }

  /* ---- 6. bulkUpdate — a target per BOARD, not one shared -------------- */
  {
    const a = await mk({ boardId: coveredBoard });
    const b = await mk({ boardId: uncoveredBoard });
    await as("mcp", () => bulkUpdate(ME, [a, b], { thisWeek: true }, AUTHOR));
    check(
      "bulkUpdate thisWeek:true resolves each task's OWN board",
      (await pinOf(a)) === LANE_ID && (await pinOf(b)) === weekLaneId(GROUP_ID, uncoveredBoard),
      `a=${await pinOf(a)} b=${await pinOf(b)}`,
    );
    await as("mcp", () => bulkUpdate(ME, [a, b], { thisWeek: false }, AUTHOR));
    check(
      "bulkUpdate thisWeek:false clears both",
      (await pinOf(a)) === null && (await pinOf(b)) === null,
    );
  }
  {
    const a = await mk({ boardId: coveredBoard });
    await as("mcp", () => bulkUpdate(ME, [a], { status: "building" }, AUTHOR));
    check("bulkUpdate → building via mcp files unpinned tasks", (await pinOf(a)) === LANE_ID);
  }

  /* ---- 7. The move is explicable on the timeline ----------------------- */
  {
    const id = await mk({ boardId: coveredBoard });
    await as("mcp", () => updateTask(id, { status: "analyzing" }, ME, AUTHOR));
    const { getTask } = await import("../src/lib/db/service");
    const detail = await getTask(id, ME);
    check(
      "activity trail explains the implicit move",
      (detail?.logs ?? []).some((l) => l.message.includes("THIS WEEK")),
      JSON.stringify((detail?.logs ?? []).map((l) => l.message)),
    );
  }
}

async function cleanup() {
  // Exactly three things can exist: our group, our lane, and any lane an OPEN
  // canvas materialised for a scratch pin — all derived from GROUP_ID, so the
  // `like` can only ever match our own nodes.
  const gone = await db
    .delete(canvasNodes)
    .where(
      or(
        inArray(canvasNodes.id, [GROUP_ID, LANE_ID]),
        like(canvasNodes.id, `${weekLaneId(GROUP_ID, null).slice(0, -"noboard".length)}%`),
      ),
    )
    .returning({ id: canvasNodes.id });
  for (const id of scratch) {
    try {
      await deleteTask(id, ME);
    } catch {
      /* best effort */
    }
  }
  console.log(
    `\nRemoved ${gone.length} throwaway node(s); cleaned up ${scratch.length} scratch task(s).`,
  );
}

main()
  .then(async () => {
    await cleanup();
    console.log(`${pass} passed, ${failures.length} failed.`);
    if (failures.length) {
      console.error("\nFailures:\n" + failures.map((f) => `  • ${f}`).join("\n"));
      process.exit(1);
    }
  })
  .catch(async (e) => {
    await cleanup();
    console.error(e);
    process.exit(1);
  });
