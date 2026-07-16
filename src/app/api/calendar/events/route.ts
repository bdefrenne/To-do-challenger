/*
  /api/calendar/events
    GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD — events across ALL connected
         calendars (shared + everyone's personal) in the window. Read-through:
         fetched live from Google, never stored.
    POST — create an event. Body: { calendar?, title, start, end?, allDay?, ... }
         `calendar` is a connection id or "shared" (the default target).
*/

import { NextRequest } from "next/server";
import { route, json, error, body, createEventSchema } from "@/lib/api";
import { listEvents, createEvent, CalendarError } from "@/lib/google/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = route(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  if (!from || !to) return error("from and to are required (YYYY-MM-DD)", 422);
  const events = await listEvents(from, to);
  return json({ events });
});

export const POST = route(async (req: NextRequest) => {
  const input = await body(req, createEventSchema);
  try {
    const { calendar, ...event } = input;
    return json({ event: await createEvent(calendar, event) }, 201);
  } catch (e) {
    if (e instanceof CalendarError) return error(e.message, e.status);
    throw e;
  }
});
