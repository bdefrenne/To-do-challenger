/*
  REPAIR STRANDED THIS WEEK PINS.

  A task filed on THIS WEEK is pinned to a lane of the starred group — either an
  existing lane's real id, or the DERIVED id (`weekLaneId`) of one the canvas is
  about to draw. Delete the group and the derived pins outlive it: they still
  read as THIS WEEK off the board views (the `wk-` prefix is enough —
  `placementOfDerivedId`), but no canvas can ever resolve them, so the cards are
  invisible there and no lane is ever materialised for them. TD2-2 found 15 such
  rows, pointing at a group that no longer exists.

  This re-homes them: every `wk-…` pin whose GROUP is no longer on any canvas is
  rewritten to whatever `resolvePlacementSection("thisWeek", …)` names for that
  task's OWN board — the starred group's lane if there is one, else the derived
  fallback lane the canvas will now draw (`WEEK_GROUP_FALLBACK`). So the cards
  keep the bucket they were filed in and become visible on the canvas again.

  Writes `tasks` only. Canvas nodes are Liveblocks-owned — an open canvas
  re-persists its own copy of storage over anything written here — so the group
  and its lanes are left to the canvas reconciler, which is what the derived ids
  exist for.

    npm run repair:week-pins            # dry run — prints what it would do
    npm run repair:week-pins -- --apply # write it
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { eq, isNotNull, like, and } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { canvasNodes, tasks } from "../src/lib/db/schema";
import { resolvePlacementSection } from "../src/lib/db/service";

const APPLY = process.argv.includes("--apply");

async function main() {
  // Every group that exists on some canvas. A `wk-` pin is live only if its
  // group prefix is one of these — the LANE itself may legitimately not exist
  // yet (that's the pending-lane case the reconciler handles), so it isn't the
  // thing to check.
  const groups = await db
    .select({ id: canvasNodes.id })
    .from(canvasNodes)
    .where(eq(canvasNodes.kind, "section_group"));
  const livePrefixes = groups.map((g) => `wk-${g.id}-`);

  const pinned = await db
    .select({
      id: tasks.id,
      ref: tasks.ref,
      title: tasks.title,
      boardId: tasks.boardId,
      pin: tasks.canvasSectionId,
    })
    .from(tasks)
    .where(and(isNotNull(tasks.canvasSectionId), like(tasks.canvasSectionId, "wk-%")));

  const stranded = pinned.filter(
    (t) => !livePrefixes.some((p) => t.pin!.startsWith(p)),
  );

  console.log(
    `${groups.length} group(s) on canvas · ${pinned.length} task(s) pinned to a THIS WEEK lane · ${stranded.length} stranded\n`,
  );
  if (!stranded.length) {
    console.log("Nothing to repair.");
    return;
  }

  // One resolve per board, not per task — the answer only depends on the board.
  const targets = new Map<string | null, string | null>();
  for (const t of stranded)
    if (!targets.has(t.boardId))
      targets.set(t.boardId, await resolvePlacementSection("thisWeek", t.boardId));

  let fixed = 0;
  let skipped = 0;
  for (const t of stranded) {
    const target = targets.get(t.boardId) ?? null;
    const label = `${t.ref ?? t.id.slice(0, 8)}  ${t.title.slice(0, 60)}`;
    if (!target) {
      // No canvas at all: there is no lane to name, and clearing the pin would
      // silently demote the card to INBOX. Leave it and say so.
      console.log(`  – ${label}\n      no target lane (no canvas) — left as ${t.pin}`);
      skipped++;
      continue;
    }
    if (target === t.pin) {
      skipped++;
      continue;
    }
    console.log(`  ✓ ${label}\n      ${t.pin}\n   →  ${target}`);
    if (APPLY)
      await db
        .update(tasks)
        .set({ canvasSectionId: target })
        .where(eq(tasks.id, t.id));
    fixed++;
  }

  console.log(
    `\n${fixed} to re-home, ${skipped} left alone.` +
      (APPLY ? " Written." : " Dry run — pass --apply to write."),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
