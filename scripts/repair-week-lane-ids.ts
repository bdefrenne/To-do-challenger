/*
  REWRITE LEGACY THIS WEEK PINS ONTO THE SYSTEM LANE IDS.

  THIS WEEK used to be a hand-made group: the user created it, named it, and
  starred it, so its id was random and its lanes needed a scheme of their own —
  `wk-<groupId>-<boardId>`. It is an ordinary system group now (TD-137), with a
  derived group id (`thisWeek-<canvasId>`) and derived lanes
  (`thisWeek-<canvasId>-<boardId>`) like every other tray.

  Old pins still name the `wk-` shape. They keep BUCKETING correctly — the board
  views read the prefix (`placementOfDerivedId`) — but the canvas no longer draws
  a node with that id, so the cards would fall through to INBOX. This rewrites
  them to the lane the reconciler will actually materialise.

  Preserves the bucket exactly: a THIS WEEK pin stays a THIS WEEK pin, on the
  same board, on the same canvas. Where the group already has a hand-made lane
  for that board, `resolvePlacementSection` picks it, so your own named lanes win
  over a derived one — same rule as everywhere else.

  Writes `tasks` only. The superseded `wk-` NODES are Liveblocks-owned and are
  swept by the canvas reconciler on next open.

    npm run repair:week-lane-ids            # dry run
    npm run repair:week-lane-ids -- --apply # write it
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { eq, like } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { canvasNodes, tasks } from "../src/lib/db/schema";
import { resolvePlacementSection } from "../src/lib/db/service";

const APPLY = process.argv.includes("--apply");

async function main() {
  const stale = await db
    .select({
      id: tasks.id,
      ref: tasks.ref,
      seq: tasks.seq,
      title: tasks.title,
      boardId: tasks.boardId,
      projectId: tasks.projectId,
      pin: tasks.canvasSectionId,
    })
    .from(tasks)
    .where(like(tasks.canvasSectionId, "wk-%"));

  if (!stale.length) {
    console.log("No legacy THIS WEEK pins. Nothing to do.");
    return;
  }

  console.log(`${stale.length} task(s) pinned to a legacy wk- lane:\n`);
  const moves: { id: string; to: string; label: string }[] = [];
  for (const t of stale) {
    // Resolved, not string-munged: the target must be whatever the server would
    // pick today — which prefers a hand-made lane over a derived one, and knows
    // which project's canvas this task belongs on.
    const to = await resolvePlacementSection("thisWeek", t.boardId, t.projectId);
    const label = t.ref ?? `#${t.seq ?? "?"}`;
    if (!to) {
      console.log(`  ${label.padEnd(8)} ${t.title}\n      NO TARGET — leaving as-is`);
      continue;
    }
    if (to === t.pin) continue;
    console.log(`  ${label.padEnd(8)} ${t.title}\n      ${t.pin}\n   →  ${to}`);
    moves.push({ id: t.id, to, label });
  }

  if (!moves.length) {
    console.log("\nNothing to rewrite.");
    return;
  }
  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to rewrite ${moves.length} pin(s).`);
    return;
  }

  for (const m of moves) {
    await db
      .update(tasks)
      .set({ canvasSectionId: m.to, updatedAt: new Date() })
      .where(eq(tasks.id, m.id));
  }
  console.log(`\nRewrote ${moves.length} pin(s).`);

  const orphans = await db
    .select({ id: canvasNodes.id })
    .from(canvasNodes)
    .where(like(canvasNodes.id, "wk-%"));
  if (orphans.length)
    console.log(
      `\n${orphans.length} superseded wk- node(s) remain — the canvas reconciler ` +
        `sweeps these on next open (they are Liveblocks-owned, so SQL can't).`,
    );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
