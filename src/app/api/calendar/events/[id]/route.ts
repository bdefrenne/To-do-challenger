/*
  /api/calendar/events/[id]
    PATCH  — update an event. Body: { calendar, title?, start?, end?, ... }
    DELETE ?calendar=<connectionId> — remove an event.
    `calendar` (which connection the event lives on) is required for both.
*/

import { NextRequest } from "next/server";
import { route, json, error, body, updateEventSchema, type AuthedCtx } from "@/lib/api";
import { updateEvent, deleteEvent, CalendarError } from "@/lib/google/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const PATCH = route(async (req: NextRequest, { params }: AuthedCtx) => {
  const { id } = await params;
  const input = await body(req, updateEventSchema);
  try {
    const { calendar, ...patch } = input;
    return json({ event: await updateEvent(calendar, id, patch) });
  } catch (e) {
    if (e instanceof CalendarError) return error(e.message, e.status);
    throw e;
  }
});

export const DELETE = route(async (req: NextRequest, { params }: AuthedCtx) => {
  const { id } = await params;
  const calendar = req.nextUrl.searchParams.get("calendar");
  if (!calendar) return error("calendar query param is required", 422);
  try {
    return json({ ok: await deleteEvent(calendar, id) });
  } catch (e) {
    if (e instanceof CalendarError) return error(e.message, e.status);
    throw e;
  }
});
