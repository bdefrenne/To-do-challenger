/*
  GET /api/calendar/connections/[id]/calendars
    The list of calendars available on this connection's Google account,
    so the user can choose which one to sync (the `calendarId`).
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { listCalendars, CalendarError } from "@/lib/google/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = route(async (_req: NextRequest, { params }: AuthedCtx) => {
  const { id } = await params;
  try {
    return json({ calendars: await listCalendars(id) });
  } catch (e) {
    if (e instanceof CalendarError) return error(e.message, e.status);
    throw e;
  }
});
