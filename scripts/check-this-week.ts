/*
  CANVAS PLACEMENT CHECK — every mutator × every surface.

  The invariant: a task an agent files with a `placement` lands on that group's
  section for its OWN board; everything else stays unpinned and surfaces in
  INBOX. And, like work-entry assignment, the STATUS-IMPLIED move to THIS WEEK is
  an agent-surface-only implicit write — the web UI never re-files a card behind
  the user's back.

  THIS WEEK gets the deepest coverage because it's the one with an implicit rule;
  the other groups (BACKLOG / LATER / DONE THIS WEEK) share one resolver with it,
  so they're checked at the resolver and at one mutator each. The deprecated
  `thisWeek` boolean is checked alongside `placement` — callers still pass it.

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

import { eq, inArray, or } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { boards, canvasNodes, tasks, users } from "../src/lib/db/schema";
import {
  createTask,
  createBoard,
  deleteBoard,
  updateTask,
  moveTask,
  bulkUpdate,
  deleteTask,
  purgeTask,
  resolveThisWeekSection,
  resolvePlacementSection,
  getCanvas,
  listCanvases,
  listPlacementSections,
} from "../src/lib/db/service";
import {
  boardsNeedingInbox,
  boardsFiledInSystemGroup,
  buildSectionMembership,
  deletionOf,
  systemLaneId,
  systemGroupId,
  systemGroupOf,
  placementOfDerivedId,
} from "../src/lib/sections";
import { withLogContext, type LogSource } from "../src/lib/db/log-context";
import type { CanvasNode, Task } from "../src/lib/types";

const AUTHOR = "check:this-week";
const TITLE = "[check:this-week] scratch — safe to delete";

/** Our throwaway nodes. Prefixed so a leftover is obvious and easy to sweep.
 *  The "!" also makes them sort FIRST: `resolvePlacementSection` breaks a
 *  multi-group tie on the lowest id, so this guarantees the scratch group wins
 *  over any real one that happens to carry the same flag. */
const LANE_ID = "!check-tw-lane";

/** The throwaway board created for the "not covered yet" case — module-level so
 *  cleanup can reach it. */
let SCRATCH_BOARD = "";
/** Second scratch group, for the BACKLOG/LATER/DONE THIS WEEK trays. */
const SYS_GROUP_ID = "!check-pl-group";
const SYS_LANE_ID = "!check-pl-lane";

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

/** Cleanup means GONE. DELETE is a soft delete now (TD2-196) — a scratch task
 *  removed with `deleteTask` alone would sit in the Trash after every run — so
 *  the checks bin it and then purge it, which is also the two-step the app makes
 *  a person take. */
async function scrub(id: string): Promise<void> {
  await deleteTask(id, ME);
  await purgeTask(id, ME);
}

async function main() {
  const roster = await db.select({ id: users.id, email: users.email, name: users.name }).from(users);
  ME = roster.find((u) => u.email === "ben@decarbony.com")?.id ?? roster[0].id;

  const [canvas] = await listCanvases();
  const full = await getCanvas(canvas.id);
  if (!full) throw new Error("no canvas");
  const nodes = full.nodes as CanvasNode[];

  // Two real boards OF THIS CANVAS'S PROJECT: one our group will have a section
  // for, one it won't.
  //
  // The project filter matters since TD-136. A canvas may legitimately show a
  // section bound to another project's board (hand-bound sections stay legal),
  // but a task on that board resolves its placement against ITS OWN project's
  // canvas — so picking one here would have the test set nodes up on canvas A
  // and assert about ids derived from canvas B.
  const ownBoards = new Set(
    (await db
      .select({ id: boards.id })
      .from(boards)
      .where(eq(boards.projectId, canvas.projectId))).map((b) => b.id),
  );
  // THIS WEEK is the real, machine-owned group (TD-137), so the test can no
  // longer invent a starred one of its own — it plants a single scratch LANE
  // inside the real group instead.
  //
  // Since TD-138 every tray holds a lane for every board, so a board with NO
  // lane no longer exists to pick. The scratch lane is given an explicitly low
  // `position` so "an existing member wins" is decided by the documented
  // ORDER BY position, id rather than by a tie-break — which is the rule under
  // test, not an accident of which board sorts first.
  const WEEK_GROUP = systemGroupId("thisWeek", canvas.id);
  const [coveredBoard] = [...ownBoards];
  if (!coveredBoard) throw new Error("this canvas's project has no boards");

  // A THROWAWAY board for the "not covered yet" half.
  //
  // Since TD-138 every tray holds a lane for every board of the project, so no
  // real board is ever uncovered — picking one would only ever test the
  // "existing member wins" path twice. A board the canvas has not reconciled
  // yet is the honest way to exercise the derived-lane fallback, which is what
  // lets the SERVER pin to a node that doesn't exist yet. Deleted in cleanup.
  const scratchBoard = await createBoard(ME, canvas.projectId, "[check] scratch");
  if (!scratchBoard) throw new Error("could not create the scratch board");
  SCRATCH_BOARD = scratchBoard.id;
  const uncoveredBoard = SCRATCH_BOARD;

  console.log(`Canvas “${canvas.name}” (${canvas.id})`);
  console.log(`  covered board   ${coveredBoard} → our lane ${LANE_ID}`);
  console.log(`  uncovered board ${uncoveredBoard}\n`);

  /* ---- 0. THIS WEEK resolves like any other tray (TD-137) --------------
   * It used to be the one placement that could silently do nothing: the group
   * was HAND-MADE, so with nothing starred there was no id to find, the resolver
   * returned null — which IS INBOX — and filing onto THIS WEEK did nothing from
   * every surface. The group is machine-owned now, with a derived id like every
   * other tray, so "nobody made one yet" is no longer a state that exists.
   *
   * Asserted on the BUCKET the id reads as, not the exact id: what must never
   * happen again is `null`. Read the bucket the way the app does — placement map
   * first, derived id second (`placementOfTask`) — because when the group already
   * HAS a lane for this board the resolver returns that lane's real id, which is
   * the documented preference ("an EXISTING member section always wins"). */
  const bucketOf = async (sectionId: string | null) => {
    if (sectionId === null) return null;
    const map = await listPlacementSections(canvas.projectId);
    return map[sectionId] ?? placementOfDerivedId(sectionId);
  };
  {
    const got = await resolveThisWeekSection(coveredBoard);
    check("THIS WEEK resolves to a lane, never null", got !== null, `got ${got}`);
    check(
      "…and that lane reads back as the THIS WEEK bucket",
      (await bucketOf(got)) === "thisWeek",
      `got ${got}`,
    );
    const id = await mk({ boardId: coveredBoard, thisWeek: true });
    const pin = await pinOf(id);
    check(
      "thisWeek:true pins the task",
      (await bucketOf(pin)) === "thisWeek",
      `got ${pin}`,
    );
  }

  /* ---- The group is an ordinary system group --------------------------- */
  {
    const groupNode: CanvasNode = {
      ...stubSection(WEEK_GROUP, { thisWeek: true }),
      kind: "section_group",
    };
    check(
      "systemGroupOf classifies the THIS WEEK group like any other tray",
      systemGroupOf(groupNode) === "thisWeek",
    );
    check(
      "its id is derived from the canvas, not random",
      WEEK_GROUP === `thisWeek-${canvas.id}`,
    );
    check(
      "…and a lane's id is derived too",
      systemLaneId("thisWeek", canvas.id, coveredBoard) ===
        `thisWeek-${canvas.id}-${coveredBoard}`,
    );
    check(
      "the group id and its 'no board' lane id never collide",
      WEEK_GROUP !== systemLaneId("thisWeek", canvas.id, null),
    );
    // The legacy shape still BUCKETS, so old pins keep reading as THIS WEEK
    // until `repair:week-lane-ids` rewrites them.
    check(
      "a legacy wk- pin still reads as the THIS WEEK bucket",
      placementOfDerivedId(`wk-${WEEK_GROUP}-${coveredBoard}`) === "thisWeek",
    );
  }

  /* ---- Our own member section, inside the REAL group ------------------- */
  await db.insert(canvasNodes).values([
    {
      id: LANE_ID,
      userId: ME,
      canvasId: canvas.id,
      kind: "section",
      content: "[check:this-week] lane",
      // Sorts ahead of any machine lane for the same board — see above.
      position: -1,
      data: { groupId: WEEK_GROUP, boardId: coveredBoard },
    },
  ]);
  console.log("Created a throwaway lane inside the THIS WEEK group.\n");

  /* ---- 1. Resolution --------------------------------------------------- */
  check(
    "a board the group covers resolves to that existing section",
    (await resolveThisWeekSection(coveredBoard)) === LANE_ID,
    `got ${await resolveThisWeekSection(coveredBoard)}`,
  );
  check(
    "a board it doesn't cover resolves to the DERIVED lane id",
    (await resolveThisWeekSection(uncoveredBoard)) ===
      systemLaneId("thisWeek", canvas.id, uncoveredBoard),
    `got ${await resolveThisWeekSection(uncoveredBoard)}`,
  );
  {
    // No board means the PROJECT is the only thing naming a canvas (TD-136).
    const got = await resolveThisWeekSection(null, canvas.projectId);
    // Either the derived lane, or an existing board-less member of the group —
    // "an EXISTING member section always wins" applies to the No-board lane too,
    // and a canvas carrying a legacy `wk-…-noboard` node still has one until the
    // reconciler sweeps it (TD-137).
    const existingNoBoard = nodes.some(
      (n) =>
        n.id === got &&
        n.kind === "section" &&
        n.data?.groupId === WEEK_GROUP &&
        !n.data?.boardId,
    );
    check(
      "a board-less task resolves to the group's 'noboard' lane",
      got === systemLaneId("thisWeek", canvas.id, null) || existingNoBoard,
      `got ${got}`,
    );
  }

  /* ---- 2. The client half: which lanes need materialising -------------- */
  {
    const pinned = systemLaneId("thisWeek", canvas.id, uncoveredBoard);
    const task = { id: "t1", parentId: null, boardId: uncoveredBoard };
    const map = { t1: { canvasSectionId: pinned } as Task };

    // Demand comes from the same helper the other trays use now — one fewer
    // code path, and the reconciler treats THIS WEEK exactly like BACKLOG.
    const needed = boardsFiledInSystemGroup("thisWeek", canvas.id, [task], map);
    check(
      "boardsFiledInSystemGroup asks for exactly the lane the server pinned to",
      needed.size === 1 && needed.has(uncoveredBoard),
      `got ${JSON.stringify([...needed])}`,
    );
    check(
      "a pin to an existing hand-made section is not demand for a derived lane",
      boardsFiledInSystemGroup(
        "thisWeek",
        canvas.id,
        [{ id: "t2", parentId: null, boardId: coveredBoard }],
        { t2: { canvasSectionId: LANE_ID } as Task },
      ).size === 0,
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
      (await pinOf(id)) === systemLaneId("thisWeek", canvas.id, uncoveredBoard),
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
      (await pinOf(a)) === LANE_ID &&
        (await pinOf(b)) === systemLaneId("thisWeek", canvas.id, uncoveredBoard),
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

  /* ---- 7. The other groups: BACKLOG / LATER / DONE THIS WEEK ----------
   * One resolver serves all four placements, so these check the parts THIS WEEK
   * can't: that each flag finds its own group, that the derived lane id is keyed
   * on the CANVAS (not the group, as `weekLaneId` is), and that `placement`
   * outranks the deprecated boolean. */
  await db.insert(canvasNodes).values([
    {
      id: SYS_GROUP_ID,
      userId: ME,
      canvasId: canvas.id,
      kind: "section_group",
      content: "[check:placement] backlog",
      data: { backlog: true, layout: "portrait" },
    },
    {
      id: SYS_LANE_ID,
      userId: ME,
      canvasId: canvas.id,
      kind: "section",
      content: "[check:placement] lane",
      data: { backlog: true, groupId: SYS_GROUP_ID, boardId: coveredBoard },
    },
  ]);

  check(
    "backlog: a board the group covers resolves to that existing section",
    (await resolvePlacementSection("backlog", coveredBoard)) === SYS_LANE_ID,
    `got ${await resolvePlacementSection("backlog", coveredBoard)}`,
  );
  check(
    "backlog: a board it doesn't cover resolves to the CANVAS-derived lane id",
    (await resolvePlacementSection("backlog", uncoveredBoard)) ===
      systemLaneId("backlog", canvas.id, uncoveredBoard),
    `got ${await resolvePlacementSection("backlog", uncoveredBoard)}`,
  );
  // Nothing here is flagged 'later', so this must NOT hand back the backlog
  // group's lane — each flag finds its own group. What it does hand back is the
  // derived LATER lane: a system tray's ids are computed from the canvas, so the
  // server can name the lane the reconciler will draw and the card lands in the
  // right tray as soon as the canvas opens. (Before that fallback existed this
  // returned null, and filing into a tray the canvas hadn't drawn yet silently
  // did nothing — which is what made a brand-new tray like TODAY unusable.)
  {
    const got = await resolvePlacementSection("later", coveredBoard);
    check(
      "each flag finds its OWN group — 'later' never resolves to the backlog lane",
      got !== SYS_LANE_ID && got !== SYS_GROUP_ID,
      `got ${got}`,
    );
    // Which canvas hosts the derived lane depends on the data (see
    // `trayCanvasId`), so assert the KIND rather than the exact id — that's the
    // part the reconciler reads to put the card in the right tray.
    check(
      "…and an unflagged tray resolves to a canvas-derived LATER lane",
      got !== null && placementOfDerivedId(got) === "later",
      `got ${got}`,
    );
  }
  check(
    "placement 'inbox' means unpinned, not a lane",
    (await resolvePlacementSection("inbox", coveredBoard)) === null,
  );
  {
    const id = await mk({ boardId: coveredBoard, placement: "backlog" });
    check("createTask placement:'backlog' files it in the backlog lane", (await pinOf(id)) === SYS_LANE_ID);
    await as("mcp", () => updateTask(id, { placement: "inbox" }, ME, AUTHOR));
    check("updateTask placement:'inbox' sends it back to INBOX", (await pinOf(id)) === null);
  }
  {
    const id = await mk({ boardId: coveredBoard });
    await as("mcp", () => moveTask(id, { placement: "backlog" }, ME, AUTHOR));
    check("moveTask placement:'backlog' files it too", (await pinOf(id)) === SYS_LANE_ID);
  }
  {
    const a = await mk({ boardId: coveredBoard });
    const b = await mk({ boardId: uncoveredBoard });
    await as("mcp", () => bulkUpdate(ME, [a, b], { placement: "backlog" }, AUTHOR));
    check(
      "bulkUpdate placement:'backlog' resolves each task's OWN board",
      (await pinOf(a)) === SYS_LANE_ID &&
        (await pinOf(b)) === systemLaneId("backlog", canvas.id, uncoveredBoard),
      `a=${await pinOf(a)} b=${await pinOf(b)}`,
    );
  }
  {
    // An explicit placement outranks the legacy boolean, which outranks status.
    const id = await mk({ boardId: coveredBoard, placement: "backlog", thisWeek: true });
    check("placement wins over the deprecated thisWeek", (await pinOf(id)) === SYS_LANE_ID);
  }
  {
    const id = await mk({ boardId: coveredBoard, canvasSectionId: LANE_ID, placement: "backlog" });
    check("an explicit canvasSectionId still wins over both", (await pinOf(id)) === LANE_ID);
  }
  {
    const pinned = systemLaneId("backlog", canvas.id, uncoveredBoard);
    const filed = boardsFiledInSystemGroup("backlog", canvas.id, [
      { id: "t3", parentId: null, boardId: uncoveredBoard },
    ], { t3: { canvasSectionId: pinned } as Task });
    check(
      "boardsFiledInSystemGroup asks for exactly the lane the server pinned to",
      filed.size === 1 && filed.has(uncoveredBoard),
      `got ${JSON.stringify([...filed])}`,
    );
  }

  /* ---- 7b. Each project resolves to ITS OWN canvas (TD-136) ------------ */
  // The regression this whole change exists for. Before it, `resolvePlacementSection`
  // scanned `section_group` nodes across EVERY canvas and took `groups[0]` ordered
  // by node id, so a task's placement landed on whichever canvas id sorted first —
  // deterministic, and unrelated to the task's project.
  {
    /** Which canvas a resolved section lives on. Three shapes:
     *   • a real node — it says so directly;
     *   • a system tray's derived lane (`<kind>-<canvasId>-<boardId>`) — the
     *     canvas id is in the middle;
     *   • a THIS WEEK lane of a HAND-MADE group (`wk-<groupId>-<boardId>`) —
     *     the group's id is random, so only the group node knows the canvas. */
    const canvasOf = async (sectionId: string): Promise<string | null> => {
      const [row] = await db
        .select({ canvasId: canvasNodes.canvasId })
        .from(canvasNodes)
        .where(eq(canvasNodes.id, sectionId))
        .limit(1);
      if (row) return row.canvasId;
      const all = await listCanvases();
      const byId = all.find((c) => sectionId.includes(c.id));
      if (byId) return byId.id;
      if (!sectionId.startsWith("wk-")) return null;
      const groups = await db
        .select({ id: canvasNodes.id, canvasId: canvasNodes.canvasId })
        .from(canvasNodes)
        .where(eq(canvasNodes.kind, "section_group"));
      return (
        groups.find((g) => sectionId.startsWith(`wk-${g.id}-`))?.canvasId ?? null
      );
    };

    // Two projects that each have a canvas AND a board to file onto.
    const allCanvases = await listCanvases();
    const pairs: { projectId: string; canvasId: string; boardId: string }[] = [];
    for (const c of allCanvases) {
      const [b] = await db
        .select({ id: boards.id })
        .from(boards)
        .where(eq(boards.projectId, c.projectId))
        .limit(1);
      if (b) pairs.push({ projectId: c.projectId, canvasId: c.id, boardId: b.id });
    }
    check(
      "at least two projects have a canvas and a board (else this proves nothing)",
      pairs.length >= 2,
      `got ${pairs.length}`,
    );

    if (pairs.length >= 2) {
      for (const bucket of ["backlog", "later", "thisWeek"] as const) {
        const landed = await Promise.all(
          pairs.map(async (p) => {
            const section = await resolvePlacementSection(bucket, p.boardId);
            return {
              ...p,
              section,
              on: section ? await canvasOf(section) : null,
            };
          }),
        );
        check(
          `placement '${bucket}' resolves onto each board's OWN project canvas`,
          landed.every((l) => l.section !== null && l.on === l.canvasId),
          landed
            .map((l) => `${l.boardId.slice(0, 8)} sec=${l.section} on=${l.on} want=${l.canvasId}`)
            .join("; "),
        );
        check(
          `…and two projects never share a '${bucket}' destination`,
          new Set(landed.map((l) => l.section)).size === landed.length,
        );
      }

      // The end-to-end version: a real task, created through the mutator.
      const other = pairs.find((p) => p.canvasId !== canvas.id);
      if (other) {
        const id = await mk({ boardId: other.boardId, placement: "backlog" });
        const pin = await pinOf(id);
        check(
          "a task on another project's board is pinned on THAT project's canvas",
          pin !== null && (await canvasOf(pin)) === other.canvasId,
          `pin=${pin} want canvas ${other.canvasId}`,
        );
      }
    }
  }

  /* ---- 8. The two-step exit for finished work -------------------------- */
  check("DELETE on a not-done card deletes it", deletionOf("building", null) === "delete");
  check("DELETE on a done card parks it", deletionOf("done", null) === "park");
  check(
    "DELETE again from DONE THIS WEEK archives it",
    deletionOf("done", "doneThisWeek") === "archive",
  );
  check(
    "…and so does a not-done card that somehow sits there",
    deletionOf("building", "doneThisWeek") === "archive",
  );
  check(
    "parking is not triggered from the other trays",
    deletionOf("done", "backlog") === "park" && deletionOf("building", "later") === "delete",
  );

  /* ---- 8b. …and the canvas variant, which has no tray to park in -------- */
  // The canvas stopped drawing DONE THIS WEEK (TD-87), so `canPark:false` is what
  // WorkspaceContext passes whenever a canvas is mounted. Same two steps, one
  // fewer place to go: a done card stays in its board's lane until DELETE
  // archives it, and accepting a REVIEW card just marks it done in place.
  check(
    "with no tray, DELETE on a done card archives instead of parking",
    deletionOf("done", null, { canPark: false }) === "archive",
  );
  check(
    "with no tray, a REVIEW card is still accepted rather than archived",
    deletionOf("review", null, { canPark: false }) === "complete",
  );
  check(
    "with no tray, a not-done card still just deletes",
    deletionOf("building", null, { canPark: false }) === "delete",
  );
  check(
    "canPark:true is the default — the board views are untouched",
    deletionOf("done", null, { canPark: true }) === "park" &&
      deletionOf("done", null) === "park",
  );

  /* ---- 8c. A DONE THIS WEEK pin is off-canvas, never INBOX ------------- */
  // Without this the missing lane reads as "unplaced", and the INBOX reconciler
  // draws a lane to hold it — finished work coming back as untriaged.
  {
    const parked = systemLaneId("doneThisWeek", canvas.id, coveredBoard);
    const tasks = [{ id: "d1", parentId: null, boardId: coveredBoard }];
    const map = { d1: { canvasSectionId: parked } as Task };
    const { unplaced, bySection } = buildSectionMembership([], tasks, map);
    check(
      "a doneThisWeek pin renders in no section and is NOT unplaced",
      unplaced.size === 0 && bySection.size === 0,
      `unplaced=${unplaced.size} sections=${bySection.size}`,
    );
    check(
      "…so no INBOX lane is built to hold it",
      boardsNeedingInbox([], tasks, map).size === 0,
    );
    // The contrast case: an ordinary unresolvable pin still falls back to INBOX.
    const strayMap = { d1: { canvasSectionId: systemLaneId("backlog", canvas.id, coveredBoard) } as Task };
    check(
      "…while a BACKLOG pin with no lane still falls through to INBOX",
      boardsNeedingInbox([], tasks, strayMap).size === 1,
    );
  }

  /* ---- 9. The move is explicable on the timeline ----------------------- */
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
  // Our two scratch groups, their lanes, and any THIS WEEK lane an OPEN canvas
  // materialised for a scratch pin — all derived from GROUP_ID, so the `like`
  // can only ever match our own nodes.
  //
  // A BACKLOG lane a canvas materialised is deliberately NOT swept: its id is
  // derived from the CANVAS, so it's a genuine lane for a real board, identical
  // to one a user would have made. It empties when the scratch tasks go, and the
  // reconciler drops an empty tray lane on its next pass.
  const gone = await db
    .delete(canvasNodes)
    .where(
      or(
        inArray(canvasNodes.id, [LANE_ID, SYS_GROUP_ID, SYS_LANE_ID]),
      ),
    )
    .returning({ id: canvasNodes.id });
  for (const id of scratch) {
    try {
      await scrub(id);
    } catch {
      /* best effort */
    }
  }
  if (SCRATCH_BOARD) {
    // Not inside a bare try/catch that could swallow a scoping mistake: a board
    // that silently survives cleanup pollutes the sidebar on every run.
    const gone = await deleteBoard(ME, SCRATCH_BOARD);
    if (!gone) console.warn(`  ! scratch board ${SCRATCH_BOARD} not deleted`);
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
