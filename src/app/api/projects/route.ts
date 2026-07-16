/*
  /api/projects
    GET  — list the user's projects, each with its boards nested.
    POST — create a project.
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  body,
  createProjectSchema,
  type AuthedCtx,
} from "@/lib/api";
import { listProjects, createProject } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, { userId }: AuthedCtx) => {
  const projects = await listProjects(userId);
  return json({ projects });
});

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const { name } = await body(req, createProjectSchema);
  const project = await createProject(userId, name);
  return json({ project }, 201);
});
