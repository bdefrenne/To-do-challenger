/*
  /api/placements
    GET — the canvas flattened to `sectionId → placement`, so a board view can
          say which bucket (INBOX / TODAY / THIS WEEK / BACKLOG / LATER /
          DONE THIS WEEK) a task is filed in without mounting a canvas — plus each
          bucket's name AS IT READS ON THE CANVAS, so a renamed group heads the
          same band on both surfaces.

  Read `src/lib/sections.ts` for what a bucket is and how a task resolves into
  one (`placementOfTask`), and `placementTitle` for the name fallback.
*/

import { NextRequest } from "next/server";
import { route, json } from "@/lib/api";
import { listPlacementGroups } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  // Scoped to one project's canvas when asked. A board view renders exactly one
  // project, and canvases are per-project, so an unscoped map would bucket other
  // projects' sections into this project's bands.
  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  const { placements, titles } = await listPlacementGroups(projectId);
  return json({ placements, titles });
});
