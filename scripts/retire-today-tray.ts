/*
  RETIRE THE TODAY TRAY — MOVE ITS CARDS TO THE TOP OF THIS WEEK (TD2-202).

  TODAY is going away as a placement. It was a machine-managed tray like the
  others, so its cards are `tasks.canvas_section_id` pins naming a derived lane
  id (`today-<canvasId>-<boardId>`). There is no column to migrate: rewriting
  those pins IS the move.

  Each pin is re-resolved through `resolvePlacementSection("thisWeek", …)`
  rather than string-munged, so it lands wherever the server itself would put a
  THIS WEEK card today — which prefers a hand-made lane over a derived one, and
  knows which project's canvas the task belongs on. Same rule as the `wk-`
  repair next door.

  TOP of THIS WEEK, by PREPENDING. Order is (position, createdAt, id) and
  `position` is doubleprecision, so the incoming cards take positions strictly
  below the target lane's current minimum. Nothing already in the lane is
  written — a dense restamp would reorder cards nobody asked to move. Negative
  positions are invisible to `nextPosition` (`coalesce(max(position),0)+1`), so
  new tasks still mint at the end.

  Only LIVE TOP-LEVEL cards are repositioned: subtasks have no pin of their own
  and follow their parent, and an archived/trashed card renders nowhere. Every
  matching pin is rewritten regardless, including archived and trashed ones, so
  nothing is left naming a lane that no longer exists.

  `updatedAt` is deliberately NOT bumped. This is a mechanical re-pin, and
  bumping it would put 48 tasks into "touched today" on Finish work and every
  activity window.

  RUN THIS BEFORE DEPLOYING the code that drops the placement: THIS WEEK
  resolves identically in both versions, so the rewrite is valid against the
  current code, and it leaves no interval where a `today-` pin reads as INBOX.

  Idempotent — a second run finds nothing to do.

  The superseded TODAY NODES are Liveblocks-owned and are swept by the canvas
  reconciler on next open. SQL must not touch them.

    npm run retire:today            # dry run
    npm run retire:today -- --apply # write it
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { and, asc, eq, isNull, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { canvasNodes, tasks } from "../src/lib/db/schema";
import { resolvePlacementSection } from "../src/lib/db/service";

const APPLY = process.argv.includes("--apply");

/** A card we're moving. `reposition` is false for the ones that render nowhere
 *  (archived/trashed) and for subtasks, which follow their parent's pin. */
interface Move {
  id: string;
  label: string;
  title: string;
  to: string;
  reposition: boolean;
  position: number;
  createdAt: Date;
}

/** The lowest `position` among the live top-level cards already pinned to a
 *  section — what the incoming cards have to get under to land on top. 0 for an
 *  empty lane, which is also what an empty `min()` should mean here. */
async function lowestPosition(sectionId: string): Promise<number> {
  const [row] = await db
    .select({ min: sql<number>`coalesce(min(${tasks.position}), 0)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.canvasSectionId, sectionId),
        isNull(tasks.parentId),
        isNull(tasks.deletedAt),
        isNull(tasks.archivedAt),
      ),
    );
  return Number(row?.min ?? 0);
}

async function main() {
  const pinned = await db
    .select({
      id: tasks.id,
      ref: tasks.ref,
      seq: tasks.seq,
      title: tasks.title,
      boardId: tasks.boardId,
      projectId: tasks.projectId,
      parentId: tasks.parentId,
      pin: tasks.canvasSectionId,
      position: tasks.position,
      createdAt: tasks.createdAt,
      archivedAt: tasks.archivedAt,
      deletedAt: tasks.deletedAt,
    })
    .from(tasks)
    .where(like(tasks.canvasSectionId, "today-%"))
    // The order they'll keep once they're on top of THIS WEEK: the canonical
    // (position, createdAt, id) — the order they read in TODAY right now.
    .orderBy(asc(tasks.position), asc(tasks.createdAt), asc(tasks.id));

  if (!pinned.length) {
    console.log("No TODAY pins. Nothing to do.");
    return;
  }

  console.log(`${pinned.length} task(s) pinned to a TODAY lane.\n`);

  /** Moves grouped by the THIS WEEK lane they're going to, so each lane's
   *  prepend is numbered against its own minimum. */
  const byTarget = new Map<string, Move[]>();
  let stranded = 0;

  for (const t of pinned) {
    const label = t.ref ?? `#${t.seq ?? "?"}`;
    const to = await resolvePlacementSection("thisWeek", t.boardId, t.projectId);
    if (!to) {
      console.log(`  ${label.padEnd(10)} NO THIS WEEK TARGET — leaving as-is: ${t.title}`);
      stranded++;
      continue;
    }
    const move: Move = {
      id: t.id,
      label,
      title: t.title,
      to,
      // Only cards that actually render on the canvas need a new position.
      reposition: t.parentId === null && !t.archivedAt && !t.deletedAt,
      position: t.position,
      createdAt: t.createdAt,
    };
    const list = byTarget.get(to);
    if (list) list.push(move);
    else byTarget.set(to, [move]);
  }

  const moves = [...byTarget.values()].flat();
  if (!moves.length) {
    console.log("\nNothing to move.");
    return;
  }

  // Number each lane's incoming run: last one lands just under the lane's
  // current top, the one before it under that, so the run keeps its order.
  const positions = new Map<string, number>();
  for (const [target, list] of byTarget) {
    const incoming = list.filter((m) => m.reposition);
    const min = await lowestPosition(target);
    incoming.forEach((m, i) => positions.set(m.id, min - (incoming.length - i)));
    console.log(
      `\n→ ${target}\n  ${list.length} card(s), ${incoming.length} repositioned ` +
        `above position ${min}:`,
    );
    for (const m of list) {
      const where = positions.has(m.id)
        ? `pos ${m.position} → ${positions.get(m.id)}`
        : "pin only";
      console.log(`    ${m.label.padEnd(10)} ${where.padEnd(22)} ${m.title.slice(0, 70)}`);
    }
  }

  console.log(
    `\n${moves.length} pin(s) to rewrite, ${positions.size} card(s) to move to the top` +
      (stranded ? `, ${stranded} left as-is (no target)` : "") +
      ".",
  );

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write it.");
    return;
  }

  for (const m of moves) {
    const pos = positions.get(m.id);
    await db
      .update(tasks)
      // No `updatedAt` — see the header. A re-pin isn't work on the task.
      .set({ canvasSectionId: m.to, ...(pos !== undefined ? { position: pos } : {}) })
      .where(eq(tasks.id, m.id));
  }
  console.log(`\nRewrote ${moves.length} pin(s).`);

  const orphans = await db
    .select({ id: canvasNodes.id })
    .from(canvasNodes)
    .where(like(canvasNodes.id, "today-%"));
  if (orphans.length)
    console.log(
      `\n${orphans.length} TODAY node(s) remain — the canvas reconciler sweeps ` +
        `these on next open (they are Liveblocks-owned, so SQL can't).`,
    );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
