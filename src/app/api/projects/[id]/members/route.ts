/*
  /api/projects/:id/members
    GET  — list the project's members (roster users), owner-scoped.
    POST — add a member (body: { userId }).

  Membership is a curation layer for the assignee picker — see schema.ts. The
  owner is always a member; the whole set replaces via PATCH /api/projects/:id
  ({ members }), while these routes offer granular add/list.
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  projectMemberSchema,
  type AuthedCtx,
} from "@/lib/api";
import { listProjectMembers, addProjectMember } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const members = await listProjectMembers(ctx.userId, id);
  return json({ members });
});

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const { userId: memberId } = await body(req, projectMemberSchema);
  const members = await addProjectMember(ctx.userId, id, memberId);
  if (!members) return error("Project not found or unknown user", 404);
  return json({ members }, 201);
});
