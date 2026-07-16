/*
  /api/calendar/connections/[id]
    PATCH  — change which underlying Google calendar this connection uses
             and/or its type. Body: { calendarId?, type? }
    DELETE — disconnect (remove the connection). Any logged-in user may
             manage any connection (trusted team).
*/

import { NextRequest } from "next/server";
import { route, json, error, body, updateConnectionSchema, type AuthedCtx } from "@/lib/api";
import {
  getConnectionById,
  getConnectionByType,
  setCalendarId,
  setConnectionType,
  setConnectionLabel,
  deleteConnection,
} from "@/lib/google/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(async (req: NextRequest, { params }: AuthedCtx) => {
  const { id } = await params;
  const { calendarId, type, label } = await body(req, updateConnectionSchema);
  const conn = await getConnectionById(id);
  if (!conn) return error("Connection not found", 404);
  // There can be at most one holidays calendar (DB-enforced). Reject a second
  // one with a clear message instead of a raw unique-violation 500.
  if (type === "holidays") {
    const existing = await getConnectionByType("holidays");
    if (existing && existing.id !== id) {
      return error(
        `“${existing.label}” is already the holidays calendar. Set it back to Standard first.`,
        409,
      );
    }
  }
  if (calendarId !== undefined) await setCalendarId(id, calendarId);
  if (type !== undefined) await setConnectionType(id, type);
  if (label !== undefined) await setConnectionLabel(id, label);
  return json({ ok: true });
});

export const DELETE = route(async (_req: NextRequest, { params }: AuthedCtx) => {
  const { id } = await params;
  return json({ ok: await deleteConnection(id) });
});
