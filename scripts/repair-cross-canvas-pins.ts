/*
  REPAIR PINS THAT POINT AT ANOTHER PROJECT'S CANVAS.

  A canvas belongs to exactly one project (TD-136), and a task's `placement`
  resolves against ITS OWN project's canvas. Before that, canvases were global
  and the server picked one for the whole instance — so pins accumulated that
  name a section on a canvas belonging to a DIFFERENT project than the task.

  Those pins still resolve (the node exists), which is what makes them worth
  repairing rather than ignoring: the task renders on a canvas that isn't its
  project's, while anything newly filed goes to the right one. The same task's
  work ends up split across two canvases with nothing saying why.

  This CLEARS them — it does not re-file. An unpinned task falls into its own
  board's INBOX lane on its own project's canvas, which is exactly where an
  untriaged task belongs; guessing a bucket on the new canvas would invent a
  filing decision nobody made.

  Writes `tasks` only. Canvas nodes are Liveblocks-owned — an open canvas
  re-persists its own copy of storage over anything written here — so the now
  empty sections are left for a human to delete on the canvas.

    npm run repair:cross-pins            # dry run — prints what it would do
    npm run repair:cross-pins -- --apply # write it
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { inArray, isNotNull } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { boards, canvases, canvasNodes, tasks } from "../src/lib/db/schema";

const APPLY = process.argv.includes("--apply");

async function main() {
  const canvasRows = await db
    .select({ id: canvases.id, projectId: canvases.projectId, name: canvases.name })
    .from(canvases);
  const canvasProject = new Map(canvasRows.map((c) => [c.id, c.projectId]));
  const canvasName = new Map(canvasRows.map((c) => [c.id, c.name]));

  const nodeRows = await db
    .select({ id: canvasNodes.id, canvasId: canvasNodes.canvasId })
    .from(canvasNodes);
  const nodeCanvas = new Map(nodeRows.map((n) => [n.id, n.canvasId]));

  const boardRows = await db
    .select({ id: boards.id, projectId: boards.projectId })
    .from(boards);
  const boardProject = new Map(boardRows.map((b) => [b.id, b.projectId]));

  const pinned = await db
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
    .where(isNotNull(tasks.canvasSectionId));

  /** The canvas a pin names: a real node says so, else a derived id
   *  (`<kind>-<canvasId>-<boardId>`) carries the canvas id inside it. A pin we
   *  can't attribute is left alone — that's `repair-week-pins`' territory. */
  const canvasOfPin = (pin: string): string | null =>
    nodeCanvas.get(pin) ?? canvasRows.find((c) => pin.includes(c.id))?.id ?? null;

  const stray: typeof pinned = [];
  for (const t of pinned) {
    if (!t.pin) continue;
    const onCanvas = canvasOfPin(t.pin);
    if (!onCanvas) continue;
    const pinProject = canvasProject.get(onCanvas);
    const ownProject = (t.boardId ? boardProject.get(t.boardId) : null) ?? t.projectId;
    if (!pinProject || !ownProject) continue;
    if (pinProject !== ownProject) stray.push(t);
  }

  if (!stray.length) {
    console.log("No cross-project pins. Nothing to do.");
    return;
  }

  console.log(
    `${stray.length} task(s) pinned to another project's canvas:\n`,
  );
  for (const t of stray) {
    const onCanvas = canvasOfPin(t.pin!);
    console.log(
      `  ${(t.ref ?? `#${t.seq ?? "?"}`).padEnd(8)} ${t.title}\n` +
        `      pinned on “${canvasName.get(onCanvas!) ?? onCanvas}” → clearing`,
    );
  }

  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to clear ${stray.length} pin(s).`);
    return;
  }

  await db
    .update(tasks)
    .set({ canvasSectionId: null, updatedAt: new Date() })
    .where(inArray(tasks.id, stray.map((t) => t.id)));
  console.log(`\nCleared ${stray.length} pin(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
