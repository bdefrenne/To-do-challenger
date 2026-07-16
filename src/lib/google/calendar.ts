/*
  ====================================================================
  CALENDAR SERVICE — read-through access to Google Calendar v3.

  Google is the source of truth. We never store events: reads fan out
  over ALL connections (shared + every personal one) for the requested
  window; writes go straight to the target calendar. Called by both the
  REST routes and the MCP tools, so a human edit and an AI edit go
  through the exact same door.
  ====================================================================
*/

import {
  accessTokenFor,
  getConnectionById,
  listConnections,
  resolveTarget,
} from "./connections";
import type { GoogleConnectionRow } from "../db/schema";

const API = "https://www.googleapis.com/calendar/v3";

/** A normalized event — flattened from Google's start/end date|dateTime shape. */
export interface CalendarEvent {
  id: string;
  connectionId: string;
  source: "shared" | "personal";
  /** The source calendar's type — "holidays" is read-only in the view. */
  type: "standard" | "holidays";
  ownerName: string;
  color: string;
  calendarId: string;
  title: string;
  /** ISO datetime, or a YYYY-MM-DD date when `allDay`. */
  start: string;
  end: string;
  allDay: boolean;
  description?: string;
  location?: string;
  htmlLink?: string;
  /** Every logged-in user may edit any calendar, so this is always true today. */
  editable: boolean;
}

/** One calendar available on a connected Google account (for the picker). */
export interface GoogleCalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

interface GEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

async function googleFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function normalize(row: GoogleConnectionRow, e: GEvent): CalendarEvent {
  const allDay = Boolean(e.start?.date);
  return {
    id: e.id,
    connectionId: row.id,
    source: row.scope,
    type: row.type,
    ownerName: row.label,
    color: row.color,
    calendarId: row.calendarId,
    title: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    allDay,
    description: e.description,
    location: e.location,
    htmlLink: e.htmlLink,
    editable: true,
  };
}

/** Google wants an event body with either `date` (all-day) or `dateTime`. */
function toEventTime(value: string, allDay: boolean) {
  if (allDay) return { date: value.slice(0, 10) };
  // Accept a bare date and promote it to start-of-day if no time was given.
  const dateTime = value.length <= 10 ? `${value}T00:00:00` : value;
  return { dateTime };
}

/* -------------------------------------------------------------------- */
/* Reads                                                                */
/* -------------------------------------------------------------------- */

/**
 * List events across every connection within [timeMin, timeMax] (RFC3339 or
 * a YYYY-MM-DD, which we widen to a full UTC day). One slow/broken calendar
 * can't sink the rest — each is fetched independently.
 */
export async function listEvents(
  timeMinISO: string,
  timeMaxISO: string,
): Promise<CalendarEvent[]> {
  const connections = await listConnections();
  if (connections.length === 0) return [];

  const timeMin = timeMinISO.length <= 10 ? `${timeMinISO}T00:00:00Z` : timeMinISO;
  const timeMax = timeMaxISO.length <= 10 ? `${timeMaxISO}T23:59:59Z` : timeMaxISO;

  const perCalendar = await Promise.all(
    connections.map(async (conn) => {
      try {
        const token = await accessTokenFor(conn);
        const params = new URLSearchParams({
          timeMin,
          timeMax,
          singleEvents: "true", // expand recurring events into instances
          orderBy: "startTime",
          maxResults: "2500",
        });
        const res = await googleFetch(
          token,
          `/calendars/${encodeURIComponent(conn.calendarId)}/events?${params}`,
        );
        if (!res.ok) {
          console.error(
            `[calendar] list failed for ${conn.label} (${res.status})`,
          );
          return [];
        }
        const data = (await res.json()) as { items?: GEvent[] };
        return (data.items ?? [])
          .filter((e) => e.status !== "cancelled" && (e.start?.date || e.start?.dateTime))
          .map((e) => normalize(conn, e));
      } catch (err) {
        console.error(`[calendar] list error for ${conn.label}`, err);
        return [];
      }
    }),
  );
  return perCalendar.flat();
}

/** List the calendars available on a connected account (for the id picker). */
export async function listCalendars(connectionId: string): Promise<GoogleCalendarInfo[]> {
  const conn = await getConnectionById(connectionId);
  if (!conn) return [];
  const token = await accessTokenFor(conn);
  const res = await googleFetch(token, `/users/me/calendarList`);
  if (!res.ok) return [];
  const data = (await res.json()) as {
    items?: Array<{ id: string; summary: string; primary?: boolean; accessRole: string }>;
  };
  return (data.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: Boolean(c.primary),
    accessRole: c.accessRole,
  }));
}

/* -------------------------------------------------------------------- */
/* Writes                                                               */
/* -------------------------------------------------------------------- */

export interface EventInput {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  description?: string;
  location?: string;
}

/**
 * Create an event. `target` is a connection id or "shared"/undefined
 * (defaults to the shared calendar). Returns the normalized event.
 */
export async function createEvent(
  target: string | undefined,
  input: EventInput,
): Promise<CalendarEvent> {
  const conn = await resolveTarget(target);
  if (!conn) {
    throw new CalendarError(
      "No target calendar. Connect the shared calendar (or pass a valid calendar id).",
    );
  }
  const allDay = Boolean(input.allDay);
  // Default the end to match the start (all-day → next day, per Google).
  const end =
    input.end ??
    (allDay ? nextDay(input.start.slice(0, 10)) : input.start);
  const body = {
    summary: input.title,
    description: input.description,
    location: input.location,
    start: toEventTime(input.start, allDay),
    end: toEventTime(end, allDay),
  };
  const token = await accessTokenFor(conn);
  const res = await googleFetch(
    token,
    `/calendars/${encodeURIComponent(conn.calendarId)}/events`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (!res.ok) throw await calendarError(res, "create");
  return normalize(conn, (await res.json()) as GEvent);
}

/** Patch an existing event on a specific connection. */
export async function updateEvent(
  connectionId: string,
  eventId: string,
  patch: Partial<EventInput>,
): Promise<CalendarEvent> {
  const conn = await getConnectionById(connectionId);
  if (!conn) throw new CalendarError("Unknown calendar.");
  const allDay = patch.allDay;
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.summary = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.start !== undefined) body.start = toEventTime(patch.start, Boolean(allDay));
  if (patch.end !== undefined) body.end = toEventTime(patch.end, Boolean(allDay));

  const token = await accessTokenFor(conn);
  const res = await googleFetch(
    token,
    `/calendars/${encodeURIComponent(conn.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  if (!res.ok) throw await calendarError(res, "update");
  return normalize(conn, (await res.json()) as GEvent);
}

/** Delete an event from a specific connection's calendar. */
export async function deleteEvent(
  connectionId: string,
  eventId: string,
): Promise<boolean> {
  const conn = await getConnectionById(connectionId);
  if (!conn) throw new CalendarError("Unknown calendar.");
  const token = await accessTokenFor(conn);
  const res = await googleFetch(
    token,
    `/calendars/${encodeURIComponent(conn.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
  // 410 = already gone; treat as success (idempotent delete).
  if (!res.ok && res.status !== 410) throw await calendarError(res, "delete");
  return true;
}

/* -------------------------------------------------------------------- */
/* Helpers                                                              */
/* -------------------------------------------------------------------- */

/** Thrown for calendar write problems; routes turn it into a 400/502. */
export class CalendarError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

async function calendarError(res: Response, op: string): Promise<CalendarError> {
  const detail = await res.text().catch(() => "");
  return new CalendarError(
    `Google Calendar ${op} failed (${res.status})${detail ? `: ${detail}` : ""}`,
    502,
  );
}

/** YYYY-MM-DD → the next day's YYYY-MM-DD (for all-day end, which is exclusive). */
function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}
