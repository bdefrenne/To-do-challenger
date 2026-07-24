/*
  Shared helpers for the REST route handlers: Zod schemas, JSON
  responses, and a wrapper that turns thrown errors into clean status
  codes. Keeps every route handler tiny and consistent.
*/

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "./auth";

/* ---- Validation schemas (shared by REST + MCP) ---- */
export const statusSchema = z.enum([
  "backlog",
  "todo",
  "analyzing",
  "analyzed",
  "building",
  "review",
  "done",
]);
export const recurrenceSchema = z.enum(["none", "daily", "weekly", "monthly"]);
/** Fibonacci story points used for `value` (payoff) and `difficulty` (effort). */
export const fibSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
]);
/** Importance ladder (priority): 2 High · 1 Elevated · 0 Normal (default) · -1 Low. */
export const importanceSchema = z
  .number()
  .int()
  .min(-1)
  .max(2) as z.ZodType<-1 | 0 | 1 | 2>;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
/** A task handle: its UUID, or its human code — the short ref people share,
 *  like "PLAT-77" (locked) or "PLAT-77*" (soft; the trailing * is optional).
 *  The service resolves either form (resolveTaskId) to the same task. */
const taskHandle = z
  .string()
  .describe(
    'A task handle: either its UUID or its human code (e.g. "PLAT-77", or ' +
      '"PLAT-77*" while soft — the trailing * is optional). Both resolve to the same task.',
  );
/** Assignee refs — each a user id, email, or display name; the service
 *  resolves them to account ids on write. */
const assigneeIdsSchema = z.array(z.string().max(120)).max(20);
const dependsOnSchema = z.array(z.string()).max(50);
const customFieldsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export const createTaskSchema = z.object({
  title: z.string().min(1, "title is required").max(500),
  status: statusSchema.optional(),
  assigneeIds: assigneeIdsSchema.optional(),
  startDate: ymd.optional(),
  dueDate: ymd.optional(),
  recurrence: recurrenceSchema.optional(),
  dependsOn: dependsOnSchema.optional(),
  customFields: customFieldsSchema.optional(),
  value: fibSchema.optional(),
  difficulty: fibSchema.optional(),
  importance: importanceSchema.optional(),
  description: z.string().max(10_000).optional(),
  parentId: taskHandle.nullable().optional(),
  boardId: z.string().nullable().optional(),
});

export const updateTaskSchema = z
  .object({
    title: z.string().min(1).max(500),
    status: statusSchema,
    assigneeIds: assigneeIdsSchema,
    startDate: ymd.nullable(),
    dueDate: ymd.nullable(),
    recurrence: recurrenceSchema,
    dependsOn: dependsOnSchema,
    customFields: customFieldsSchema,
    value: fibSchema.nullable(),
    difficulty: fibSchema.nullable(),
    importance: importanceSchema,
    description: z.string().max(10_000).nullable(),
    /* ---- Workflow: revisable free-text fields (null clears).
       UI labels: Analysis / Technical Plan / Summary. ---- */
    analysisSummary: z.string().max(20_000).nullable(),
    plan: z.string().max(20_000).nullable(),
    summary: z.string().max(20_000).nullable(),
  })
  .partial();

/* ---- Workflow: notes, commits ---- */
export const noteTypeSchema = z.enum([
  "decision",
  "progress",
  "milestone",
  "blocker",
  "question",
  "fyi",
  "review",
]);

export const addNoteSchema = z.object({
  note: z.string().min(1).max(10_000),
  type: noteTypeSchema.nullable().optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
});

export const resolveNoteSchema = z.object({
  resolved: z.boolean(),
});

export const linkCommitSchema = z.object({
  sha: z.string().min(4).max(64),
  subject: z.string().max(500).nullable().optional(),
});

export const moveTaskSchema = z.object({
  parentId: taskHandle.nullable().optional(),
  status: statusSchema.optional(),
  position: z.number().optional(),
  boardId: z.string().nullable().optional(),
});

export const commentSchema = z.object({
  message: z.string().min(1).max(10_000),
  author: z.string().max(120).optional(),
});

/* ---- Bulk operations ---- */

/** Same patch to many tasks: `{ ids, patch }`. Reuses updateTaskSchema so the
 *  field set + null-clearing rules stay identical to a single update. */
export const bulkUpdateSchema = z.object({
  ids: z.array(taskHandle).min(1, "at least one id").max(500),
  patch: updateTaskSchema,
});

/** One step of a `bulkApply` batch — a discriminated union on `op`, each member
 *  reusing the matching single-task schema. */
export const bulkOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), input: createTaskSchema }),
  z.object({ op: z.literal("update"), id: taskHandle, patch: updateTaskSchema }),
  z.object({ op: z.literal("move"), id: taskHandle, target: moveTaskSchema }),
  z.object({ op: z.literal("complete"), id: taskHandle, done: z.boolean().optional() }),
  z.object({ op: z.literal("comment"), id: taskHandle, message: z.string().min(1).max(10_000) }),
  z.object({ op: z.literal("delete"), id: taskHandle }),
]);

/** Ordered heterogeneous ops: `{ operations }`. The 1000 ceiling just rejects
 *  absurd payloads; the service truncates the actual batch at MAX_BULK_OPS. */
export const bulkApplySchema = z.object({
  operations: z.array(bulkOpSchema).min(1, "at least one operation").max(1000),
});

/** The /api/tasks/bulk body: either shape. `operations` is tried first so a
 *  body carrying it never falls through to the `{ ids, patch }` branch. */
export const bulkRequestSchema = z.union([bulkApplySchema, bulkUpdateSchema]);

/* ---- Calendar events (Google Calendar, read-through) ---- */

/** A date (YYYY-MM-DD) or an RFC3339 datetime — the service normalizes it. */
const dateOrDateTime = z.string().min(1).max(40);

/** Create an event. `calendar` is a connection id or "shared" (default). */
export const createEventSchema = z.object({
  calendar: z.string().max(120).optional(),
  title: z.string().min(1, "title is required").max(500),
  start: dateOrDateTime,
  end: dateOrDateTime.optional(),
  allDay: z.boolean().optional(),
  description: z.string().max(10_000).optional(),
  location: z.string().max(500).optional(),
});

/** Update an event. `calendar` (which connection it lives on) is required. */
export const updateEventSchema = z.object({
  calendar: z.string().min(1, "calendar is required").max(120),
  title: z.string().min(1).max(500).optional(),
  start: dateOrDateTime.optional(),
  end: dateOrDateTime.optional(),
  allDay: z.boolean().optional(),
  description: z.string().max(10_000).optional(),
  location: z.string().max(500).optional(),
});

/** A calendar connection's semantic type. */
export const calendarTypeSchema = z.enum(["standard", "holidays"]);

/** Update a connection: the underlying Google calendar and/or its type.
 *  Partial — send just the field(s) you're changing. */
export const updateConnectionSchema = z
  .object({
    calendarId: z.string().min(1).max(1024),
    type: calendarTypeSchema,
    /** Display name shown in the legend + as an event's owner. */
    label: z.string().min(1).max(120),
  })
  .partial()
  .refine(
    (v) => v.calendarId !== undefined || v.type !== undefined || v.label !== undefined,
    { message: "provide calendarId, type and/or label" },
  );

/* ---- Profile ---- */

/** Edit your own profile. Partial — send just the field(s) you're changing.
 *  `avatarUrl: null` clears the picture (back to initials). */
export const profileSchema = z
  .object({
    name: z.string().min(1, "name can't be empty").max(120),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "use a #rrggbb hex color"),
    avatarUrl: z.string().url().max(2048).nullable(),
    language: z.enum(["en", "fr"]),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "provide a field to update" });

/* ---- Projects & Boards ---- */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "use a #rrggbb hex color");
const pictureUrl = z.string().url().max(2048);
const gitFolder = z.string().max(512);
/** Markdown readme explaining what a project/board is and its constraints. */
const description = z.string().max(20000);
/** Roster user ids for a project's member set (assignee-picker curation). */
const memberIds = z.array(z.string().min(1)).max(50);

export const createProjectSchema = z.object({
  name: z.string().min(1, "name is required").max(120),
  code: z.string().min(1).max(8).optional(),
  color: hexColor.optional(),
  image: pictureUrl.optional(),
  gitFolder: gitFolder.optional(),
  description: description.optional(),
  members: memberIds.optional(),
});

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(120),
    code: z.string().min(1).max(8),
    color: hexColor,
    image: pictureUrl.nullable(),
    gitFolder: gitFolder.nullable(),
    description: description.nullable(),
    members: memberIds,
  })
  .partial();

/** Add a single member to a project (POST …/members). */
export const projectMemberSchema = z.object({
  userId: z.string().min(1, "userId is required"),
});

export const createBoardSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  name: z.string().min(1, "name is required").max(120),
  code: z.string().min(1).max(8).optional(),
  color: hexColor.optional(),
  image: pictureUrl.optional(),
  gitFolder: gitFolder.optional(),
  description: description.optional(),
});

export const updateBoardSchema = z
  .object({
    name: z.string().min(1).max(120),
    code: z.string().min(1).max(8),
    color: hexColor,
    image: pictureUrl.nullable(),
    gitFolder: gitFolder.nullable(),
    description: description.nullable(),
  })
  .partial();

/** Reorder all boards within a project — `orderedIds` is the new top-to-bottom
 *  (and left-to-right) order; the server assigns positions 1..N to match. */
export const reorderBoardsSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  orderedIds: z.array(z.string().min(1)).min(1),
});

/* ---- Canvas / whiteboard ---- */
const canvasNodeKindSchema = z.enum([
  "text",
  "section",
  "draw",
  "image",
  "section_group",
]);
const canvasNodeData = z.record(z.string(), z.unknown());

export const createCanvasSchema = z.object({
  name: z.string().min(1, "name is required").max(120),
});

export const updateCanvasSchema = z
  .object({
    name: z.string().min(1).max(120),
    viewport: z.object({
      x: z.number(),
      y: z.number(),
      scale: z.number(),
    }),
  })
  .partial()
  .refine((v) => v.name !== undefined || v.viewport !== undefined, {
    message: "provide name and/or viewport",
  });

/** One node in a batch save. `id` is optional — omit it for a fresh node the
 *  server will assign an id to; include it to update an existing node. */
export const canvasNodeInputSchema = z.object({
  id: z.string().optional(),
  kind: canvasNodeKindSchema,
  content: z.string().max(20_000).optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive().max(100_000),
  height: z.number().positive().max(100_000),
  color: z.string().max(40).nullable().optional(),
  position: z.number().optional(),
  data: canvasNodeData.optional(),
});

/** The canvas editor's debounced save: upsert some nodes, delete others. */
export const saveCanvasNodesSchema = z.object({
  upserts: z.array(canvasNodeInputSchema).max(2000).optional(),
  deletes: z.array(z.string()).max(2000).optional(),
});

/**
 * Thrown by the service layer when a write carried an `If-Match`/
 * `expectedUpdatedAt` token that no longer matches the stored row (another
 * writer got there first). `route()` turns it into a 409 that carries the
 * fresh task so the client can reconcile.
 */
export class ConflictError extends Error {
  constructor(public current: unknown) {
    super("Task was modified by another writer");
  }
}

/**
 * Thrown by the service layer when a write is well-formed but violates a
 * business rule (e.g. archiving a task that isn't done). `route()` turns it
 * into a 400.
 */
export class ValidationError extends Error {}

/* ---- Responses ---- */
export const json = <T>(data: T, status = 200) =>
  NextResponse.json(data, { status });

export const error = (message: string, status = 400) =>
  NextResponse.json({ error: message }, { status });

/**
 * Wraps a handler: resolves the current user (session cookie or bearer
 * token), catches validation/auth errors, and returns consistent JSON.
 * The handler receives the authenticated `userId` on its ctx, so every
 * query it makes is scoped to that user's own tasks.
 */
export function route(
  handler: (req: NextRequest, ctx: AuthedCtx) => Promise<NextResponse>,
) {
  return async (req: NextRequest, ctx: RouteCtx) => {
    try {
      const userId = await requireUser(req);
      return await handler(req, { ...ctx, userId });
    } catch (e) {
      if (e instanceof AuthError) return error(e.message, e.status);
      if (e instanceof ConflictError)
        return json({ error: e.message, task: e.current }, 409);
      if (e instanceof ValidationError) return error(e.message, 400);
      if (e instanceof z.ZodError)
        return error(e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 422);
      console.error("[api] unhandled error", e);
      return error("Internal server error", 500);
    }
  };
}

export interface RouteCtx {
  params: Promise<Record<string, string>>;
}

/** RouteCtx plus the authenticated user id, injected by `route()`. */
export interface AuthedCtx extends RouteCtx {
  userId: string;
}

/** Parse + validate a JSON body against a schema (throws ZodError). */
export async function body<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  return schema.parse(raw);
}
