/*
  Shared helpers for the REST route handlers: Zod schemas, JSON
  responses, and a wrapper that turns thrown errors into clean status
  codes. Keeps every route handler tiny and consistent.
*/

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAuth } from "./auth";
import { withLogContext } from "./db/log-context";
import { APP_TIMEZONE } from "./workday";

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
/** Which canvas group a task is filed in — its triage bucket, independent of
 *  `status`. See `TaskPlacement` in types.ts. */
export const placementSchema = z.enum([
  "inbox",
  "thisWeek",
  "backlog",
  "later",
  "doneThisWeek",
]);
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

/* ---- Reading tasks -------------------------------------------------------
   ONE declaration of "which tasks do you want", spread into both the REST
   query parsing (/api/tasks) and the MCP tool args. A filter added here shows
   up on every surface at once, which is the only way the three stay in step. */

/** A window edge: a bare day (`YYYY-MM-DD`, meaning that whole day) or a full
 *  ISO instant for sub-day precision. */
const windowEdge = z
  .string()
  .max(40)
  .regex(
    /^\d{4}-\d{2}-\d{2}([T ].*)?$/,
    "use YYYY-MM-DD (that whole day) or a full ISO instant",
  );

/** How much of each task to return. The default is deliberately `compact`:
 *  descriptions and the free-text working fields are what make a whole-board
 *  read unreadably large. */
export const taskDetailSchema = z.enum(["compact", "standard", "full"]);

export const taskFilterShape = {
  status: z.array(statusSchema).optional(),
  boardId: z.string().optional(),
  projectId: z.string().optional(),
  assignee: z
    .string()
    .max(120)
    .optional()
    .describe("a user id, email, or display name — matches one of a task's assignees"),
  actor: z
    .string()
    .max(120)
    .optional()
    .describe(
      "who TOUCHED the task (the activity log's actor) — id, email or display name. " +
        'This, not `assignee`, answers "what did I work on". Windowed by the ' +
        "activity window below.",
    ),
  text: z.string().max(200).optional().describe("substring of title or description"),
  dueBefore: ymd.optional(),
  dueAfter: ymd.optional(),
  overdue: z.boolean().optional().describe("past due and not done"),
  statusChangedFrom: windowEdge
    .optional()
    .describe("status last moved on/after this day — the 'what changed' axis"),
  statusChangedTo: windowEdge.optional().describe("…and on/before this day"),
  completedFrom: windowEdge.optional().describe("completed on/after this day"),
  completedTo: windowEdge.optional().describe("…and on/before this day"),
  updatedFrom: windowEdge.optional().describe("edited on/after this day"),
  updatedTo: windowEdge.optional().describe("…and on/before this day"),
  createdFrom: windowEdge.optional().describe("created on/after this day"),
  createdTo: windowEdge.optional().describe("…and on/before this day"),
  tz: z
    .string()
    .max(60)
    .optional()
    .describe(
      `IANA zone the bare-date window edges mean, e.g. "America/New_York" ` +
        `(default ${APP_TIMEZONE})`,
    ),
  includeArchived: z
    .boolean()
    .optional()
    .describe("also include archived tasks (excluded by default)"),
  archivedOnly: z
    .boolean()
    .optional()
    .describe("return ONLY archived tasks (the Archived view)"),
  includeDeleted: z
    .boolean()
    .optional()
    .describe("also include deleted tasks, the ones in the Trash (excluded by default)"),
  deletedOnly: z
    .boolean()
    .optional()
    .describe("return ONLY deleted tasks — the Trash, newest deleted first"),
  /** Callers that want done work hidden pass `false` themselves — notably the
   *  MCP tools, which default it off. Left undefined, done tasks are included,
   *  because the web board needs its Done column. */
  includeDone: z.boolean().optional(),
  sort: z
    .enum(["position", "recent"])
    .optional()
    .describe("`recent` = most recent status move first; makes `limit` meaningful"),
  limit: z.number().int().min(1).max(1000).optional(),
};

export const taskFilterSchema = z.object(taskFilterShape);
export type TaskFilterInput = z.infer<typeof taskFilterSchema>;

/* ---- Reading completions (the Done view) --------------------------------
   Its own shape, deliberately NOT part of `taskFilterShape`: the unit here is a
   done EVENT — one per credited person per day — not a task, so the two share
   only their window edges. Parsed straight off `searchParams`, hence the coerce
   on `limit`. */
export const completionsQueryShape = {
  /** Chunk start — the client walks this back four weeks at a time. */
  from: windowEdge,
  /** Chunk end. A bare day includes that whole day (`dateWindow` makes the
   *  instant range half-open), so consecutive chunks tile exactly. */
  to: windowEdge,
  projectId: z.string().max(120).optional(),
  boardId: z.string().max(120).optional(),
  creditedTo: z
    .string()
    .max(120)
    .optional()
    .describe("narrow to one person's work — id, email, or display name"),
  tz: z
    .string()
    .max(60)
    .optional()
    .describe(
      `IANA zone the day/week buckets are read in, e.g. "America/New_York" ` +
        `(default ${APP_TIMEZONE})`,
    ),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
};

export const completionsQuerySchema = z.object(completionsQueryShape);
export type CompletionsQuery = z.infer<typeof completionsQuerySchema>;

/* ---- Work days ----------------------------------------------------------
   A work day is addressed by (project, working day) — the acting user is always
   the third part of the key and comes from the request, never the body: you
   cannot draft someone else's day for them. */

/** The working day itself. Bare `YYYY-MM-DD`, because a standup talks about days
 *  rather than instants; `lib/workday.ts` decides which day an instant is in. */
export const workDaySchema = {
  projectId: z.string().max(120),
  day: ymd.describe("the working day, YYYY-MM-DD (see lib/workday.ts)"),
  tz: z
    .string()
    .max(60)
    .optional()
    .describe(
      `IANA zone the day is read in, e.g. "America/New_York" (default ${APP_TIMEZONE})`,
    ),
};

export const workDayQuerySchema = z.object(workDaySchema);
export type WorkDayQuery = z.infer<typeof workDayQuerySchema>;

/** Reading ONE person's write-up in full. The only place the standup prose
 *  crosses the wire — ranged reads carry `previewOf` output instead (PLAT-403),
 *  so this is what the Done view calls when someone opens a column. `userId` is
 *  whose day to read, not who's asking: a team reads each other's standups the
 *  same way it reads each other's completions. */
export const writeUpQuerySchema = z.object({
  ...workDaySchema,
  userId: z.string().max(120).describe("whose day to read (an account id)"),
});
export type WriteUpQuery = z.infer<typeof writeUpQuerySchema>;

/** "Finish work" — the two authored fields, and nothing else. Completions are
 *  NOT in here on purpose: each task is confirmed on its own, so the close-out
 *  batches the asking rather than the deciding. */
export const finishWorkSchema = z.object({
  ...workDaySchema,
  bullets: z
    .string()
    .max(10_000)
    .nullable()
    .optional()
    .describe("standup points that aren't about any one task"),
  summary: z
    .string()
    .max(20_000)
    .nullable()
    .optional()
    .describe("the standup write-up for the day"),
});
export type FinishWorkInput = z.infer<typeof finishWorkSchema>;

/** Logging work that never reached the board — a call, a conversation. Becomes a
 *  real task, already done, credited to `day`. */
export const logPastWorkSchema = z.object({
  title: z.string().min(1, "title is required").max(500),
  day: ymd.describe("the working day the work actually happened on"),
  boardId: z.string().max(120).nullable().optional(),
  description: z.string().max(10_000).optional(),
});
export type LogPastWorkInput = z.infer<typeof logPastWorkSchema>;

export const createTaskSchema = z.object({
  title: z.string().min(1, "title is required").max(500),
  status: statusSchema.optional(),
  assigneeIds: assigneeIdsSchema.optional(),
  startDate: ymd.optional(),
  dueDate: ymd.optional(),
  recurrence: recurrenceSchema.optional(),
  dependsOn: dependsOnSchema.optional(),
  customFields: customFieldsSchema.optional(),
  canvasSectionId: z.string().nullable().optional(),
  placement: placementSchema.optional(),
  /** Deprecated boolean spelling of `placement` (true = thisWeek, false =
   *  inbox), kept so callers written against it keep working. */
  thisWeek: z.boolean().optional(),
  value: fibSchema.optional(),
  difficulty: fibSchema.optional(),
  importance: importanceSchema.optional(),
  description: z.string().max(10_000).optional(),
  parentId: taskHandle.nullable().optional(),
  boardId: z.string().nullable().optional(),
  /** Fractional sort key within the (status, parent) group. Omit to append at
   *  the end; the outline sends the midpoint of the row's neighbours so a line
   *  typed mid-list stays mid-list. */
  position: z.number().optional(),
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
    canvasSectionId: z.string().nullable(),
    placement: placementSchema,
    /** Deprecated boolean spelling of `placement`. */
    thisWeek: z.boolean(),
  /** Which END of the destination group to land at: "top" (do it next) or
   *  "bottom" (after everything already there). Resolved server-side against the
   *  lane the placement names, so it means the same thing on the canvas, on the
   *  Boards view and over MCP. An explicit `position` wins. */
    end: z.enum(["top", "bottom"]),
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

/* ---- Workflow: commits ---- */

export const linkCommitSchema = z.object({
  sha: z.string().min(4).max(64),
  subject: z.string().max(500).nullable().optional(),
});

export const moveTaskSchema = z.object({
  parentId: taskHandle.nullable().optional(),
  status: statusSchema.optional(),
  position: z.number().optional(),
  boardId: z.string().nullable().optional(),
  /** Re-pin/unpin on a canvas Section. Omitted on a board change means "clear
   *  it" — see moveTask. */
  canvasSectionId: z.string().nullable().optional(),
  /** File it in a canvas group by name instead of by section id. */
  placement: placementSchema.optional(),
  /** Deprecated boolean spelling of `placement`. */
  thisWeek: z.boolean().optional(),
  /** Which END of the destination group to land at: "top" (do it next) or
   *  "bottom" (after everything already there). Resolved server-side against the
   *  lane the placement names, so it means the same thing on the canvas, on the
   *  Boards view and over MCP. An explicit `position` wins. */
  end: z.enum(["top", "bottom"]).optional(),
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
  z.object({ op: z.literal("archive"), id: taskHandle, archived: z.boolean().optional() }),
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
  /** The project this canvas lays out. Required — a canvas with no project has
   *  no placements, because that's the axis the server resolves against. */
  projectId: z.string().min(1, "projectId is required"),
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
 * Thrown by the service layer when a write carried an `expectedUpdatedAt`
 * token (header `X-Expected-Updated-At` on the REST API) that no longer
 * matches the stored row (another writer got there first). `route()` turns it
 * into a 409 that carries the fresh task so the client can reconcile.
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
 *
 * `details` rides along for rules a CLIENT can act on rather than just report.
 * The message is for a person; details are for code — a refusal that says "3
 * subtasks aren't done" can then offer to finish them, which needs the ids and a
 * `code` to switch on. Same shape of thinking as `ConflictError`, which already
 * ships the fresh task next to its message. Plain data only: it is merged into
 * the JSON body verbatim, so keep the keys stable — they are API surface.
 */
export interface RuleDetails {
  /** Stable machine name for the rule, e.g. `"open_subtasks"`. */
  code: string;
  [key: string]: unknown;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public details?: RuleDetails,
  ) {
    super(message);
  }
}

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
      const { userId, via } = await requireAuth(req);
      // Surface attribution for the activity log: a browser session is the web
      // UI; a bearer token on the REST API is a script/AI call.
      const source = via === "session" ? "ui" : "api";
      return await withLogContext({ actorId: userId, source }, () =>
        handler(req, { ...ctx, userId }),
      );
    } catch (e) {
      if (e instanceof AuthError) return error(e.message, e.status);
      if (e instanceof ConflictError)
        return json({ error: e.message, task: e.current }, 409);
      if (e instanceof ValidationError)
        // `details` (when the rule carries any) is spread beside the message, so
        // a client can act on the rule instead of only showing its text.
        return json({ error: e.message, ...(e.details ?? {}) }, 400);
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
