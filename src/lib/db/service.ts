/*
  ====================================================================
  TASK SERVICE — the one place task logic lives.
  The web UI (via /api/tasks), the REST API, and the MCP server all
  call THESE functions. One code path for humans and AI => no drift.
  Returns the app's `Task` shape (see ../types.ts) so screens and AIs
  get the same clean, self-describing objects.
  ====================================================================
*/

import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNotNull, isNull, ne, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { del } from "@vercel/blob";
import { blobAuth } from "@/lib/blob";
import { previewOf } from "@/lib/format";
import { db } from "./client";
import {
  tasks,
  taskLogs,
  taskStatusEvents,
  taskAttachments,
  taskNotes,
  taskCommits,
  projects,
  projectMembers,
  boards,
  users,
  canvases,
  canvasNodes,
  workDays,
  type WorkDayRow,
  type NewWorkDayRow,
  type TaskRow,
  type TaskStatusEventRow,
  type NewTaskStatusEventRow,
  type TaskAttachmentRow,
  type TaskNoteRow,
  type TaskCommitRow,
  type ProjectRow,
  type BoardRow,
  type CanvasRow,
  type CanvasNodeRow,
} from "./schema";
import { STATUS_LABEL } from "@/lib/statuses";
import type { PublicUser } from "./users";
import { ConflictError, ValidationError } from "@/lib/api";
import { daysAgo } from "@/lib/format";
import { currentLogContext, withWorkedOn, type LogSource } from "./log-context";
import { deriveCode, sanitizeCode, formatCode } from "@/lib/refs";
import { MAX_BULK_OPS, type OpResult } from "@/lib/bulk";
import {
  dateWindow,
  workingDayOf,
  workingDayStart,
  currentWorkingDay,
  APP_TIMEZONE,
} from "@/lib/workday";
import {
  systemLaneId,
  systemGroupOf,
  placementOfTask,
  type PlacementMap,
  type PlacementTitles,
} from "@/lib/sections";
import type {
  Task,
  TaskStatus,
  TaskPlacement,
  Recurrence,
  FibPoints,
  Importance,
  CustomFieldValue,
  TaskLogEntry,
  Attachment,
  Project,
  Board,
  Note,
  NoteType,
  TaskCommit,
  Canvas,
  CanvasNode,
  CanvasNodeKind,
  CanvasViewport,
} from "@/lib/types";

/** A Task plus the fields AIs care about (nesting/order/timestamps). */
export interface TaskDTO extends Task {
  parentId: string | null;
  position: number;
  statusSince: string;
  /** When the code was locked (≈ when work started / first handoff), or null. */
  lockedAt?: string | null;
  createdAt: string;
  subtasks?: TaskDTO[];
}

const iso = (d: Date | string | null) =>
  d == null ? undefined : (d instanceof Date ? d.toISOString() : d);

/* ---- Date windows ----
   Every "what happened between X and Y" read goes through `dateWindow`, and
   every "which day is this row on" through `workingDayOf`. Both live in
   `lib/workday.ts` — pure, so the UI and the check scripts resolve days the
   same way the queries do — and both are re-exported here because this module
   is where callers have always found them.

   `dateWindow` exists because each caller used to hand-roll `new Date(from)` /
   `new Date(to)` and compare inclusively, which made the most natural window of
   all — a single day, from = to — resolve to the empty range [00:00, 00:00]. */

export { dateWindow, workingDayOf };

/** Conditions placing a timestamp column inside a half-open window. */
function inWindow(
  col: SQL | AnyColumn,
  { start, end }: { start?: Date; end?: Date },
): SQL[] {
  const conds: SQL[] = [];
  if (start) conds.push(sql`${col} >= ${start}`);
  if (end) conds.push(sql`${col} < ${end}`);
  return conds;
}

/**
 * The inclusive WORKING-DAY bounds a window covers, for the `date` columns that
 * store a day rather than an instant (`worked_on`, `work_days.day`).
 *
 * One function so those columns can't disagree with the instant columns beside
 * them: the last included day is the one containing `end - 1ms`, since `end` is
 * exclusive.
 */
const dayBounds = (
  w: { start?: Date; end?: Date },
  tz: string,
): { fromDay?: string; toDay?: string } => ({
  ...(w.start ? { fromDay: workingDayOf(w.start, tz) } : {}),
  ...(w.end
    ? { toDay: workingDayOf(new Date(w.end.getTime() - 1), tz) }
    : {}),
});

/**
 * The same window, but over a status event's EFFECTIVE day — `worked_on` when
 * it's set, otherwise the day `at` falls on.
 *
 * Two branches rather than one `coalesce`, because the two columns are different
 * types: `at` is an instant compared against the window's half-open bounds,
 * while `worked_on` is already a working day and compares as a date. Folding
 * them together in SQL would mean converting instants to days per row in the
 * reader's zone, which no index could serve.
 *
 * The date bounds come from `dayBounds`, derived from the window itself so they
 * can't disagree with it.
 */
function effectiveWindow(
  w: { start?: Date; end?: Date },
  tz: string,
): SQL[] {
  if (!w.start && !w.end) return [];
  const { fromDay, toDay } = dayBounds(w, tz);
  const dayConds: SQL[] = [];
  if (fromDay)
    dayConds.push(sql`${taskStatusEvents.workedOn} >= ${fromDay}`);
  if (toDay) dayConds.push(sql`${taskStatusEvents.workedOn} <= ${toDay}`);
  const byInstant = and(
    isNull(taskStatusEvents.workedOn),
    ...inWindow(taskStatusEvents.at, w),
  );
  const byDay = and(isNotNull(taskStatusEvents.workedOn), ...dayConds);
  return [sql`(${or(byInstant, byDay)})`];
}

/** Keep importance inside the -1…2 ladder — guards legacy rows and any stray
 *  out-of-range write (validation already enforces this at the API edge). */
const clampImportance = (v: number): Importance =>
  Math.max(-1, Math.min(2, v)) as Importance;

const rowToAttachment = (r: TaskAttachmentRow): Attachment => ({
  id: r.id,
  filename: r.filename,
  mimeType: r.mimeType,
  size: r.size,
  url: r.url,
  createdAt: iso(r.createdAt)!,
});

/* -------------------------------------------------------------------- */
/* Codes / refs                                                          */
/* -------------------------------------------------------------------- */

/** Preloaded owner codes, so a list of tasks renders soft codes with no N+1.
 *  TEAM-WIDE: tasks are visible to everyone, so we preload every owner's codes
 *  and resolve each task's prefix by its own creator (`row.userId`). */
interface CodeCtx {
  board: Map<string, string | null>;
  project: Map<string, string | null>;
  /** Every user's personal code, keyed by user id (the board→project→USER
   *  fallback prefix for that user's board-less tasks). */
  userCode: Map<string, string | null>;
}

/** Load every board/project/user code on the instance in one shot. The
 *  `userId` arg is ignored (kept so the many callers don't churn). */
async function codeCtx(_userId?: string): Promise<CodeCtx> {
  const [boardRows, projectRows, userRows] = await Promise.all([
    db.select({ id: boards.id, code: boards.code }).from(boards),
    db.select({ id: projects.id, code: projects.code }).from(projects),
    db.select({ id: users.id, code: users.code }).from(users),
  ]);
  return {
    board: new Map(boardRows.map((r) => [r.id, r.code])),
    project: new Map(projectRows.map((r) => [r.id, r.code])),
    userCode: new Map(userRows.map((r) => [r.id, r.code])),
  };
}

/** Resolve the current prefix for a task (board → project → owning user). Takes
 *  just the owning fields, so a not-yet-inserted task can resolve one too. */
function resolvePrefix(
  row: { boardId: string | null; projectId: string | null; userId: string },
  ctx?: CodeCtx,
): string | null {
  if (!ctx) return null;
  const fromBoard = row.boardId ? ctx.board.get(row.boardId) : null;
  if (fromBoard) return fromBoard;
  const fromProject = row.projectId ? ctx.project.get(row.projectId) : null;
  if (fromProject) return fromProject;
  return ctx.userCode.get(row.userId) ?? null;
}

/** The displayed code: the frozen `ref` when locked, else a soft `PREFIX-seq*`. */
function displayCode(row: AnyTaskRow, ctx?: CodeCtx): string | undefined {
  if (row.refLocked && row.ref) return row.ref;
  if (row.seq == null) return undefined;
  const prefix = resolvePrefix(row, ctx);
  if (!prefix) return undefined;
  return formatCode(prefix, row.seq, false);
}

function rowToTask(
  row: AnyTaskRow,
  commentCount: number,
  attachments: Attachment[] = [],
  ctx?: CodeCtx,
): TaskDTO {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    code: displayCode(row, ctx),
    ref: row.ref,
    refLocked: row.refLocked,
    // Absent on a list read (see LIST_TASK_COLUMNS) — `undefined` then means
    // "not fetched", distinct from the `null` of a task that has none.
    analysisSummary: "analysisSummary" in row ? row.analysisSummary : undefined,
    plan: "plan" in row ? row.plan : undefined,
    summary: "summary" in row ? row.summary : undefined,
    assigneeIds: row.assigneeIds ?? [],
    startDate: row.startDate ?? undefined,
    dueDate: row.dueDate ?? undefined,
    recurrence: row.recurrence,
    dependsOn: row.dependsOn ?? [],
    customFields: (row.customFields as Record<string, CustomFieldValue>) ?? {},
    canvasSectionId: row.canvasSectionId ?? null,
    value: (row.value as FibPoints | null) ?? undefined,
    difficulty: (row.difficulty as FibPoints | null) ?? undefined,
    importance: clampImportance(row.importance ?? 0),
    description: row.description ?? undefined,
    commentCount: commentCount || undefined,
    boardId: row.boardId,
    projectId: row.projectId,
    parentId: row.parentId,
    position: row.position,
    statusSince: iso(row.statusSince)!,
    lockedAt: iso(row.lockedAt) ?? null,
    completedAt: iso(row.completedAt),
    archivedAt: iso(row.archivedAt) ?? null,
    deletedAt: iso(row.deletedAt) ?? null,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt),
    attachments: attachments.length ? attachments : undefined,
  };
}

/* ---- Ref allocation + locking (atomic, no interactive txns) ---- */

/** Atomically bump an owner's counter and return the seq it hands out. */
async function allocSeq(scope: "board" | "project" | "user", id: string): Promise<number> {
  if (scope === "board") {
    const [r] = await db
      .update(boards).set({ nextSeq: sql`${boards.nextSeq} + 1` })
      .where(eq(boards.id, id)).returning({ next: boards.nextSeq });
    return Number(r.next) - 1;
  }
  if (scope === "project") {
    const [r] = await db
      .update(projects).set({ nextSeq: sql`${projects.nextSeq} + 1` })
      .where(eq(projects.id, id)).returning({ next: projects.nextSeq });
    return Number(r.next) - 1;
  }
  const [r] = await db
    .update(users).set({ nextSeq: sql`${users.nextSeq} + 1` })
    .where(eq(users.id, id)).returning({ next: users.nextSeq });
  return Number(r.next) - 1;
}

/** Current ref owner for a task (board → project → owning user). The user-scope
 *  fallback is the task's CREATOR (`row.userId`) so a board-less task keeps its
 *  owner's code prefix even when another team member edits it; `userId` is the
 *  fallback for brand-new rows that don't carry a creator yet. */
function ownerOf(
  row: { boardId: string | null; projectId: string | null; userId?: string },
  userId: string,
): { scope: "board" | "project" | "user"; id: string } {
  if (row.boardId) return { scope: "board", id: row.boardId };
  if (row.projectId) return { scope: "project", id: row.projectId };
  return { scope: "user", id: row.userId ?? userId };
}

/** Every code on the instance — used to keep prefixes unique TEAM-WIDE (so a
 *  ref like `MKT-3` resolves to exactly one task across all owners). */
async function existingCodes(userId: string): Promise<Set<string>> {
  const ctx = await codeCtx(userId);
  const set = new Set<string>();
  for (const c of ctx.board.values()) if (c) set.add(c.toUpperCase());
  for (const c of ctx.project.values()) if (c) set.add(c.toUpperCase());
  for (const c of ctx.userCode.values()) if (c) set.add(c.toUpperCase());
  return set;
}

/** Make a candidate prefix unique across the user's prefixes (excluding the
 *  entity's own current code, so re-saving the same value is a no-op). */
async function uniqueFrom(
  userId: string,
  candidate: string,
  exclude?: string | null,
): Promise<string> {
  const taken = await existingCodes(userId);
  if (exclude) taken.delete(exclude.toUpperCase());
  const base = candidate || "TASK";
  if (!taken.has(base.toUpperCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}${n}`.slice(0, 4);
    if (!taken.has(cand.toUpperCase())) return cand;
  }
  return base; // pathological; accept a dup rather than loop forever
}

/** Derive a code from a NAME (initials) and make it unique. */
const uniqueCode = (userId: string, name: string) =>
  uniqueFrom(userId, deriveCode(name));

/** Statuses that represent committed work — entering any of them locks the
 *  code (the first handoff, To Do → Analyzing, and everything after). */
const LOCKING_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "analyzing",
  "analyzed",
  "building",
  "review",
  "done",
]);

/** The two *active-work* states. Entering one is a claim — "I'm on this now" —
 *  so it records the acting user as an assignee (see `claimsWork`). Excludes
 *  the resting states (analyzed/review/done). */
const WORK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "analyzing",
  "building",
]);

/** Statuses that mean "this is in flight" — entering one auto-places the task in
 *  the canvas's THIS WEEK group, because an agent moving a task here is doing it
 *  NOW. Excludes `done`: finishing something is no reason to drag it onto this
 *  week's board. Only applies to a task nobody has pinned by hand — see
 *  `resolveThisWeekSection`. */
const THIS_WEEK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "analyzing",
  "analyzed",
  "building",
  "review",
]);

/**
 * Where a "this week" task goes: the section for `boardId` inside that project's
 * canvas's THIS WEEK group, or null only when the project has no canvas — then
 * a placement genuinely has nowhere to go and the caller leaves the task
 * unpinned, i.e. in INBOX.
 *
 * A thin wrapper now that THIS WEEK is an ordinary system group (TD-137); kept
 * because "resolve this week" is what most callers actually mean, and the name
 * documents the implicit status rule that uses it.
 *
 * An EXISTING member section for that board always wins, so the user's own lanes
 * ("Platform", "Racing", …) are what agents drop work into. Only when the group
 * doesn't cover the board yet do we return the DERIVED lane id — a node the
 * canvas will materialise on its next reconcile. Writing the node here instead
 * would be invisible to any open canvas, since nodes live in Liveblocks storage,
 * not in the row we'd insert.
 */
export async function resolveThisWeekSection(
  boardId: string | null,
  projectId: string | null = null,
): Promise<string | null> {
  return resolvePlacementSection("thisWeek", boardId, projectId);
}

/**
 * Where a task goes for a given `placement` — the pin to write, or null for
 * "leave it unpinned", which is what INBOX *is*.
 *
 * All three pinned placements work the same way, and the doc above explains why:
 * find the flagged group, prefer a lane it already has for this board, else name
 * the lane the canvas will materialise. They differ only in which `data` flag
 * marks the group and how the fallback lane id is derived — THIS WEEK's is keyed
 * on the group id (the group is hand-made, so its id is random), the system
 * groups' on the canvas id (their ids are themselves derived from it).
 */
/**
 * Which canvas a project's machine-managed trays belong on — the canvas to
 * derive a not-yet-drawn lane id against (see `resolvePlacementSection`).
 *
 * One lookup, because `canvases.project_id` is unique: a project has exactly one
 * canvas. This replaces ~50 lines that GUESSED — scan for the starred THIS WEEK
 * group, else count placement groups per canvas, else take the first by
 * position. Every one of those heuristics was reaching for the fact the column
 * now states, and each was stable only by accident: the id they produce is a
 * promise that a particular canvas will materialise that lane, so answering with
 * a different canvas next call strands the first pin. Ordering tricks made the
 * guess repeatable; they could never make it right, because nothing in the data
 * said which canvas a task's placement belonged on (TD-136).
 *
 * Null only if the project has no canvas — then a placement genuinely has
 * nowhere to go, and the caller leaves the task in INBOX.
 */
async function canvasIdForProject(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(eq(canvases.projectId, projectId))
    .limit(1);
  return row?.id ?? null;
}

/** The project a task's placement should resolve against: its board's project,
 *  or — for a board-less task — the project it was filed under directly. Both
 *  columns exist on `tasks`; the board is preferred because a task can be moved
 *  between boards without its stale `projectId` being rewritten. */
async function projectForPlacement(
  boardId: string | null,
  projectId: string | null,
): Promise<string | null> {
  if (boardId) {
    const [row] = await db
      .select({ projectId: boards.projectId })
      .from(boards)
      .where(eq(boards.id, boardId))
      .limit(1);
    if (row?.projectId) return row.projectId;
  }
  return projectId;
}

export async function resolvePlacementSection(
  placement: TaskPlacement,
  boardId: string | null,
  projectId: string | null = null,
): Promise<string | null> {
  if (placement === "inbox") return null;

  // WHICH CANVAS is decided by the task, not by a scan. Before TD-136 this
  // query had no canvas filter and took `groups[0]` ordered by node id, so with
  // two canvases a task's placement landed on whichever canvas id sorted first —
  // deterministic, and unrelated to the project the task belongs to.
  const project = await projectForPlacement(boardId, projectId);
  if (!project) return null;
  const canvasId = await canvasIdForProject(project);
  if (!canvasId) return null;

  // Each placement's name IS the `data` flag that marks its group, so the query
  // is the same for all of them.
  const flag = placement;

  const [group] = await db
    .select({ id: canvasNodes.id, canvasId: canvasNodes.canvasId })
    .from(canvasNodes)
    .where(
      and(
        eq(canvasNodes.canvasId, canvasId),
        eq(canvasNodes.kind, "section_group"),
        sql`${canvasNodes.data}->>${flag} = 'true'`,
      ),
    )
    .orderBy(asc(canvasNodes.id))
    .limit(1);

  if (!group) {
    // No group flagged for this placement on this project's canvas yet. Every
    // group and lane id here is derivable from the canvas id, so we can name the
    // lane the canvas will materialise on its next reconcile — the same
    // name-a-node-that-doesn't-exist-yet trick the THIS WEEK path uses once its
    // group exists, one level up: for THIS WEEK the GROUP is named too
    // (`WEEK_GROUP_FALLBACK`), because a hand-made group has no id to find.
    //
    // Without this, filing into a group the canvas hasn't drawn yet silently did
    // nothing and the card stayed in INBOX — invisible for a brand-new tray
    // (TODAY on every existing canvas), for any canvas whose trays haven't been
    // materialised, and for THIS WEEK on every canvas with no starred group,
    // which made the board view's THIS WEEK band unfillable (TD2-2).
    return systemLaneId(placement, canvasId, boardId);
  }

  const [existing] = await db
    .select({ id: canvasNodes.id })
    .from(canvasNodes)
    .where(
      and(
        eq(canvasNodes.canvasId, group.canvasId),
        eq(canvasNodes.kind, "section"),
        sql`${canvasNodes.data}->>'groupId' = ${group.id}`,
        boardId === null
          ? sql`${canvasNodes.data}->>'boardId' is null`
          : sql`${canvasNodes.data}->>'boardId' = ${boardId}`,
      ),
    )
    .orderBy(asc(canvasNodes.position), asc(canvasNodes.id))
    .limit(1);
  if (existing) return existing.id;

  return systemLaneId(placement, group.canvasId, boardId);
}

/** How a placement change reads on the activity timeline. Every move is
 *  announced — a card that relocated itself with no explanation is the thing
 *  these lines exist to prevent. */
const PLACEMENT_LOG: Record<TaskPlacement, string> = {
  inbox: "📥 Moved back to INBOX",
  today: "☀️ Moved to TODAY",
  thisWeek: "📅 Moved to THIS WEEK",
  backlog: "🗂️ Moved to BACKLOG",
  later: "🕓 Moved to LATER",
  doneThisWeek: "✅ Moved to DONE THIS WEEK",
};

/**
 * The placement a write asks for, or undefined for "don't move it".
 *
 * `thisWeek` is the older, boolean spelling of the same idea, kept working for
 * every caller written against it (the MCP tool contract, agent instructions,
 * `scripts/check-this-week.ts`). Normalised here, once, so the four mutators
 * below only ever reason about `placement`.
 */
function askedPlacement(input: {
  placement?: TaskPlacement;
  thisWeek?: boolean;
}): TaskPlacement | undefined {
  if (input.placement !== undefined) return input.placement;
  if (input.thisWeek !== undefined) return input.thisWeek ? "thisWeek" : "inbox";
  return undefined;
}

/**
 * WORK-ENTRY ASSIGNMENT — who gets recorded when a task starts moving.
 *
 * Surfaces where the writer is an agent acting FOR the user (Claude over MCP, a
 * bearer-token script, the Telegram bot): entering a work status means "I'm on
 * this now", so the actor joins the assignees and the board records who it's
 * for. The web UI is deliberately absent — a human dragging a card across a
 * column isn't claiming it (cf. TD-15, where forcing self-assignment on create
 * was itself the bug); they have the picker and the SPACE shortcut.
 *
 * Read from the ambient request context rather than a per-call flag, for the
 * same reason log attribution is (see log-context.ts): it's one per-request
 * fact that ~5 mutators need, and a defaulted boolean makes every future
 * mutator and route silently wrong. This way policy lives at the chokepoint and
 * new code inherits it. Outside a request (seed/backfill scripts) there's no
 * context, so nothing is assigned — fails safe.
 */
const ASSIGNING_SOURCES: ReadonlySet<LogSource> = new Set<LogSource>([
  "api",
  "mcp",
  "telegram",
]);

/** Add the acting user to an assignee list — idempotent, order-preserving. */
const withActor = (list: string[], userId: string) =>
  list.includes(userId) ? list : [...list, userId];

/* -------------------------------------------------------------------- */
/* Status events — the record of WHOSE WORK a transition is              */
/* -------------------------------------------------------------------- */

/**
 * Who a transition should be CREDITED to — resolved once, here, at write time,
 * so no reader ever has to guess. Returns one entry per credited person, or a
 * single `null` when nobody can honestly be credited.
 *
 * The rule follows what each surface MEANS:
 *
 * - **Agent surfaces** (`api`/`mcp`/`telegram`) — the actor is the worker: they
 *   drove the change through their own account, and `claimsWork` has already
 *   put them on the task. Credit the actor.
 * - **The web UI** — moving a card is scheduling, not doing. Credit the
 *   task's ASSIGNEES: Ben dragging Antho's card into Building is recording that
 *   *Antho* is building it. This is the same reasoning that keeps `ui` out of
 *   `ASSIGNING_SOURCES`, applied to attribution.
 * - **Nobody assigned** — hand-entering a work status means you're picking it up
 *   yourself, so credit the actor. Any other status with no assignee is
 *   genuinely unattributable: `null`, which a digest reports as "closed, owner
 *   unknown" rather than crediting whoever pressed the button.
 *
 * Outside a request (seed/backfill scripts) there's no actor, so this credits
 * the assignees or nobody — it never invents one. Same fail-safe as the
 * assignment policy.
 */
function creditFor(
  to: TaskStatus,
  assigneeIds: string[],
  actorId: string | undefined,
  source: LogSource | undefined,
): (string | null)[] {
  if (source && ASSIGNING_SOURCES.has(source) && actorId) return [actorId];
  if (assigneeIds.length) return [...assigneeIds];
  if (WORK_STATUSES.has(to) && actorId) return [actorId];
  return [null];
}

/** The append-only row(s) for one status transition — one per credited person.
 *  Pure, so the bulk path can batch many transitions into a single INSERT. */
function statusEventRows(input: {
  taskId: string;
  from: TaskStatus | null;
  to: TaskStatus;
  assigneeIds: string[];
  at: Date;
}): NewTaskStatusEventRow[] {
  const ctx = currentLogContext();
  return creditFor(input.to, input.assigneeIds, ctx?.actorId, ctx?.source).map(
    (creditedTo) => ({
      taskId: input.taskId,
      fromStatus: input.from,
      toStatus: input.to,
      at: input.at,
      source: ctx?.source,
      actorId: ctx?.actorId,
      creditedTo,
      // Null unless the close-out is reconciling a day that already ended, in
      // which case `at` still records when we learned and this records which
      // day the work belongs to.
      workedOn: ctx?.workedOn ?? null,
    }),
  );
}

/** Record one status transition. Fire-and-forget: nothing to close, nothing to
 *  keep in sync — which is the whole reason this is events and not spans. */
async function recordStatusEvent(input: {
  taskId: string;
  from: TaskStatus | null;
  to: TaskStatus;
  assigneeIds: string[];
  at: Date;
}): Promise<void> {
  await db.insert(taskStatusEvents).values(statusEventRows(input));
}

/** Does writing `status` from the current surface claim the task for its actor?
 *  No transition check: writing "building" onto an already-building task
 *  back-fills the actor, which is what you want when an agent picks up
 *  something already parked in Building. */
function claimsWork(status?: TaskStatus | null): boolean {
  if (status == null || !WORK_STATUSES.has(status)) return false;
  const source = currentLogContext()?.source;
  return source !== undefined && ASSIGNING_SOURCES.has(source);
}

/** Does writing `status` from the current surface also FILE the task on THIS
 *  WEEK's board? Same surface rule as `claimsWork`, for the same reason: an agent
 *  moving a task into work is telling us it's this week's, while a human dragging
 *  a card across a Kanban column would be startled to find it re-filed on the
 *  canvas. An explicit `thisWeek` still works from every surface. */
function statusImpliesThisWeek(status?: TaskStatus | null): boolean {
  if (status == null || !THIS_WEEK_STATUSES.has(status)) return false;
  const source = currentLogContext()?.source;
  return source !== undefined && ASSIGNING_SOURCES.has(source);
}

/**
 * Compute the fields that freeze a task's soft code into a locked `ref`
 * (allocating a seq if it doesn't have one yet). Returns null if it's already
 * locked. Shared by `mintRef` and the auto-lock in `updateTask`/`moveTask`, so
 * every path that starts real work funnels through the same freeze.
 */
async function computeLockFields(
  current: TaskRow,
  userId: string,
  ctx: CodeCtx,
): Promise<{ ref: string; refLocked: true; lockedAt: Date; seq: number } | null> {
  if (current.refLocked && current.ref) return null;
  const owner = ownerOf(current, userId);
  let prefix = resolvePrefix(current, ctx);
  if (!prefix) prefix = await ensureOwnerCode(owner, userId);
  const seq = current.seq ?? (await allocSeq(owner.scope, owner.id));
  return { ref: `${prefix}-${seq}`, refLocked: true, lockedAt: new Date(), seq };
}

/**
 * Lock a task's code (idempotent). Freezes the current soft code into `ref`.
 * Triggered on handoff (work_on_task / lock_task / Copy prompt) or automatically
 * when a task's status enters the working part of the spine (see `updateTask`),
 * so a "real" task never lacks a locked code.
 *
 * A handoff also ASSIGNS the acting user (merged, never clobbering) — handing a
 * task to Claude is starting work on it, so the board should say who it's for.
 * Unlike the status-driven claim in `claimsWork`, this applies on every surface:
 * Copy prompt is a web-UI click and must still assign. And it applies whether or
 * not the code needed locking — the second Copy-prompt click on an
 * already-locked task is the common case, and it used to write nothing at all.
 */
export async function mintRef(
  handle: string,
  userId: string,
  author = "You",
): Promise<TaskDTO | null> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return null;
  const current = (
    await db.select().from(tasks).where(eq(tasks.id, id))
  )[0];
  if (!current) return null;
  const ctx = await codeCtx(userId);
  const assigneeIds = withActor(current.assigneeIds, userId);
  const autoAssigned = assigneeIds.length > current.assigneeIds.length;
  const lock = await computeLockFields(current, userId, ctx);

  // Already locked: nothing to freeze, but the handoff may still need to record
  // the assignee — so this is only a true no-op when there's nothing to add.
  if (!lock) {
    if (!autoAssigned) return rowToTask(current, 0, [], ctx);
    const [row] = await db
      .update(tasks)
      .set({ assigneeIds, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    if (!row) return rowToTask(current, 0, [], ctx);
    await log(id, "updated", await autoAssignNote(userId), author);
    return rowToTask(row, 0, [], ctx);
  }

  const [row] = await db
    .update(tasks)
    .set({
      ref: lock.ref,
      refLocked: true,
      lockedAt: lock.lockedAt,
      seq: lock.seq,
      assigneeIds,
      updatedAt: lock.lockedAt,
    })
    .where(and(eq(tasks.id, id), eq(tasks.refLocked, false)))
    .returning();
  if (!row) {
    // Locked concurrently — return the fresh row.
    const fresh = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
    return fresh ? rowToTask(fresh, 0, [], ctx) : null;
  }
  await log(
    id,
    "updated",
    `🔒 Locked as ${lock.ref}` +
      (autoAssigned ? ` · ${await autoAssignNote(userId)}` : ""),
    author,
  );
  return rowToTask(row, 0, [], ctx);
}

/** Ensure an owner (board/project/user) has a `code`; derive + persist if not. */
async function ensureOwnerCode(
  owner: { scope: "board" | "project" | "user"; id: string },
  userId: string,
): Promise<string> {
  if (owner.scope === "board") {
    const [cur] = await db
      .select({ code: boards.code, name: boards.name })
      .from(boards).where(eq(boards.id, owner.id)).limit(1);
    if (cur?.code) return cur.code;
    const code = await uniqueCode(userId, cur?.name ?? "Task");
    await db.update(boards).set({ code }).where(eq(boards.id, owner.id));
    return code;
  }
  if (owner.scope === "project") {
    const [cur] = await db
      .select({ code: projects.code, name: projects.name })
      .from(projects).where(eq(projects.id, owner.id)).limit(1);
    if (cur?.code) return cur.code;
    const code = await uniqueCode(userId, cur?.name ?? "Task");
    await db.update(projects).set({ code }).where(eq(projects.id, owner.id));
    return code;
  }
  const [cur] = await db
    .select({ code: users.code, name: users.name })
    .from(users).where(eq(users.id, owner.id)).limit(1);
  if (cur?.code) return cur.code;
  const code = await uniqueFrom(userId, deriveCode(cur?.name ?? "Me"));
  await db.update(users).set({ code }).where(eq(users.id, owner.id));
  return code;
}

/* ---- Row → DTO converters for notes / commits ---- */

const rowToNote = (r: TaskNoteRow): Note => ({
  id: r.id,
  taskId: r.taskId,
  canvasId: r.canvasId,
  x: r.x,
  y: r.y,
  type: r.type,
  note: r.note,
  tags: r.tags ?? [],
  author: r.author,
  actorId: r.actorId,
  createdAt: iso(r.createdAt)!,
  resolvedAt: iso(r.resolvedAt),
});

const rowToCommit = (r: TaskCommitRow): TaskCommit => ({
  id: r.id,
  taskId: r.taskId,
  sha: r.sha,
  subject: r.subject,
  createdAt: iso(r.createdAt)!,
});

/** Nest flat rows into a tree, preserving position order at each level. */
function buildTree(
  rows: AnyTaskRow[],
  counts: Map<string, number>,
  attachments: Map<string, Attachment[]>,
  ctx?: CodeCtx,
): TaskDTO[] {
  const byId = new Map<string, TaskDTO>();
  for (const r of rows)
    byId.set(r.id, rowToTask(r, counts.get(r.id) ?? 0, attachments.get(r.id), ctx));
  const roots: TaskDTO[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.parentId && byId.has(r.parentId)) {
      const parent = byId.get(r.parentId)!;
      (parent.subtasks ??= []).push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Comment counts across the team's tasks (tasks are team-visible; see the
 *  schema note on `tasks.userId`). The `userId` arg is ignored — kept only so
 *  the many callers don't churn. */
async function commentCounts(_userId?: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ taskId: taskLogs.taskId, n: sql<number>`count(*)::int` })
    .from(taskLogs)
    .where(eq(taskLogs.kind, "comment"))
    .groupBy(taskLogs.taskId);
  return new Map(rows.map((r) => [r.taskId, r.n]));
}

/** Attachments grouped by taskId, team-wide (tasks are team-visible). Ordered
 *  oldest-first. The `userId` arg is ignored — kept for caller stability. */
async function attachmentsByTask(
  _userId?: string,
): Promise<Map<string, Attachment[]>> {
  const rows = await db
    .select({ a: taskAttachments })
    .from(taskAttachments)
    .orderBy(asc(taskAttachments.createdAt));
  const map = new Map<string, Attachment[]>();
  for (const { a } of rows) {
    const list = map.get(a.taskId) ?? [];
    list.push(rowToAttachment(a));
    map.set(a.taskId, list);
  }
  return map;
}

/**
 * Resolve a task HANDLE — either a raw UUID or a human ref/code like `INBO-22`
 * (locked) or `INBO-22*` (soft) — to the task's canonical UUID. Tasks are
 * TEAM-WIDE, so this resolves across every owner's tasks; `userId` is ignored
 * (kept so the many callers don't churn). Humans and AIs see and quote the ref
 * everywhere (it's what `list_tasks`/`search_tasks` surface), so every
 * id-taking entry point runs its handle through here first. Returns null if
 * nothing matches.
 */
export async function resolveTaskId(
  handle: string,
  _userId?: string,
  opts?: { includeTrashed?: boolean },
): Promise<string | null> {
  if (!handle) return null;
  // A task in the Trash resolves to NOTHING, so every id-taking entry point
  // refuses it without a check of its own: it can't be edited, moved, completed,
  // commented on or nested under. `restoreTask` / `purgeTask` are the two callers
  // that pass `includeTrashed` — they're the only operations a deleted task has.
  const live = opts?.includeTrashed ? undefined : isNull(tasks.deletedAt);

  // Fast path: a direct UUID (what most callers already pass).
  const direct = (
    await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, handle), live))
      .limit(1)
  )[0];
  if (direct) return direct.id;

  // Human ref/code: `PREFIX-SEQ`, optionally with a trailing soft `*`.
  const norm = handle.trim().replace(/\*+$/, "").toUpperCase();
  const dash = norm.lastIndexOf("-");
  if (dash <= 0 || dash === norm.length - 1) return null;

  // Locked tasks freeze the exact string into `ref` — match it directly.
  const locked = (
    await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(sql`upper(${tasks.ref}) = ${norm}`, live))
      .limit(1)
  )[0];
  if (locked) return locked.id;

  // Unlocked tasks show a SOFT code computed from owner prefix + seq (never
  // stored), so resolve those by matching the current prefix against the seq.
  const seq = Number(norm.slice(dash + 1));
  if (!Number.isInteger(seq)) return null;
  const prefix = norm.slice(0, dash);
  const [seqRows, ctx] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.seq, seq), eq(tasks.refLocked, false), live)),
    codeCtx(),
  ]);
  const match = seqRows.find((row) => resolvePrefix(row, ctx) === prefix);
  return match?.id ?? null;
}

/** True if the task exists (team-wide — anyone may reference/edit any task). */
async function ownsTask(id: string, _userId?: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
      .limit(1)
  )[0];
  return !!row;
}

async function log(
  taskId: string,
  kind: (typeof taskLogs.$inferInsert)["kind"],
  message: string,
  author?: string,
) {
  const ctx = currentLogContext();
  await db.insert(taskLogs).values({
    taskId,
    kind,
    message,
    author,
    actorId: ctx?.actorId,
    source: ctx?.source,
  });
}

/* -------------------------------------------------------------------- */
/* Reads                                                                 */
/* -------------------------------------------------------------------- */

/** Optional scoping/filtering for task reads (used by list + search). */
export interface TaskFilter {
  /** Only tasks on this board. */
  boardId?: string;
  /** Only tasks whose board belongs to this project. */
  projectId?: string;
  /** Only tasks in any of these statuses. */
  status?: TaskStatus[];
  /** Only tasks with this assignee (matches one of a task's assignees). */
  assignee?: string;
  /** Case-insensitive substring match on title or description. */
  text?: string;
  /** Only tasks due on/before this date (YYYY-MM-DD). */
  dueBefore?: string;
  /** Only tasks due on/after this date (YYYY-MM-DD). */
  dueAfter?: string;
  /** Only tasks past due and not done. */
  overdue?: boolean;
  /** Include archived tasks alongside active ones (default: archived excluded). */
  includeArchived?: boolean;
  /** Return ONLY archived tasks (for the Archived view). Overrides includeArchived. */
  archivedOnly?: boolean;
  /** Include soft-DELETED tasks alongside live ones (default: excluded). */
  includeDeleted?: boolean;
  /** Return ONLY deleted tasks — the Trash view. Overrides includeDeleted. */
  deletedOnly?: boolean;
  /** DELTA read: only tasks whose `updatedAt` is strictly after this instant
   *  (an ISO timestamp, not a date). Pair it with `listTaskIds` to spot
   *  deletions — see the `?since=` branch of /api/tasks. */
  updatedAfter?: string;
  /** Fetch the revisable working fields (analysisSummary / plan / summary) too.
   *  Off by default — see LIST_TASK_COLUMNS: they dominate a board payload and
   *  only a task's own detail view renders them, so a list read leaves them in
   *  Postgres. Set it only for a caller that will actually show them. */
  includeWorkingFields?: boolean;

  /* ---- Activity windows ------------------------------------------------
     "What changed between X and Y", the axis a standup or a daily summary
     actually asks on. Each pair is a `dateWindow` (bare YYYY-MM-DD = that
     whole day; `to` is inclusive of its day, exclusive of the next). Undefined
     ends are open, so passing only `From` means "since". */

  /** Tasks whose status last moved inside the window (`statusSince`). */
  statusChangedFrom?: string;
  statusChangedTo?: string;
  /** Tasks completed inside the window (`completedAt`). */
  completedFrom?: string;
  completedTo?: string;
  /** Tasks edited inside the window (`updatedAt`). */
  updatedFrom?: string;
  updatedTo?: string;
  /** Tasks created inside the window (`createdAt`). */
  createdFrom?: string;
  createdTo?: string;

  /**
   * Tasks this user actually TOUCHED — the activity log's `actorId`, which is
   * the only record of who did the work. Distinct from `assignee` (who it's
   * for, often stale or empty) and from the owner (who created it, credited
   * even when someone else did it all).
   *
   * Any log kind counts as a touch: a status move, an edit, a comment, a
   * commit link. Windowed by `actorFrom`/`actorTo`, which default to whichever
   * activity window the caller already gave — so "what did I do on the 4th?"
   * needs the date once, not twice.
   */
  actor?: string;
  actorFrom?: string;
  actorTo?: string;

  /** Drop done tasks. Left undefined they're INCLUDED — the web board needs
   *  its Done column, so the "hide done" default belongs to the callers that
   *  want it (the MCP tools), never to this layer. */
  includeDone?: boolean;

  /** IANA zone the bare-date window edges are read in (default UTC). */
  tz?: string;

  /** Cap on rows returned. Pair with `sort` — truncating a position-ordered
   *  list keeps an arbitrary slice, which is rarely what a capped read wants. */
  limit?: number;
  /** `position` = the board's own order (default). `recent` = most recent
   *  status move first, the useful order for an activity window. */
  sort?: "position" | "recent";
}

/** The filter keys a caller can add to narrow an over-large read. Surfaced in
 *  the MCP truncation envelope so the next call can be the right one. */
export const TASK_FILTER_KEYS = [
  "status",
  "boardId",
  "projectId",
  "assignee",
  "actor",
  "text",
  "statusChangedFrom",
  "statusChangedTo",
  "completedFrom",
  "completedTo",
  "updatedFrom",
  "updatedTo",
  "includeDone",
  "limit",
] as const;

/** Build the WHERE for the team's tasks, narrowed by an optional filter. Tasks
 *  are team-visible, so there is no owner fence; `userId` is ignored. */
function taskWhere(_userId: string, filter?: TaskFilter): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  if (filter?.boardId) conds.push(eq(tasks.boardId, filter.boardId));
  if (filter?.projectId) {
    conds.push(eq(tasks.projectId, filter.projectId));
  }
  if (filter?.status?.length) conds.push(inArray(tasks.status, filter.status));
  // Array-membership: assigneeIds is a text[] of user ids. The caller resolves
  // a human name/email to an id before setting this filter.
  if (filter?.assignee)
    conds.push(sql`${filter.assignee} = ANY(${tasks.assigneeIds})`);
  if (filter?.text) {
    const pat = `%${filter.text}%`;
    conds.push(
      or(ilike(tasks.title, pat), ilike(sql`coalesce(${tasks.description}, '')`, pat)),
    );
  }
  // Exclusive, instant-precise watermark for a DELTA read (PLAT-403): "only
  // rows touched since I last synced". Deliberately NOT `updatedFrom`, which is
  // a day-granular activity window and would re-send the whole day.
  if (filter?.updatedAfter)
    conds.push(sql`${tasks.updatedAt} > ${filter.updatedAfter}::timestamptz`);
  if (filter?.dueBefore) conds.push(sql`${tasks.dueDate} <= ${filter.dueBefore}`);
  if (filter?.dueAfter) conds.push(sql`${tasks.dueDate} >= ${filter.dueAfter}`);
  if (filter?.overdue) {
    // CURRENT_DATE is the server's date (UTC on Vercel) — fine for a personal board.
    conds.push(sql`${tasks.dueDate} < CURRENT_DATE`);
    conds.push(sql`${tasks.status} <> 'done'`);
  }
  // Archived tasks are hidden from every active surface by default. `archivedOnly`
  // powers the Archived view; `includeArchived` returns both.
  if (filter?.archivedOnly) conds.push(isNotNull(tasks.archivedAt));
  else if (!filter?.includeArchived) conds.push(isNull(tasks.archivedAt));
  // Deleted tasks are in the Trash, which is nowhere: they leave every active
  // read here (this is the one WHERE the board, table, kanban, search, digests
  // and delta syncs all share) and come back only via `deletedOnly`, which is
  // what the Trash view asks for. `resolveTaskId` is the matching fence on the
  // write side — see `deleteTask`.
  if (filter?.deletedOnly) conds.push(isNotNull(tasks.deletedAt));
  else if (!filter?.includeDeleted) conds.push(isNull(tasks.deletedAt));

  if (filter?.includeDone === false) conds.push(ne(tasks.status, "done"));

  const tz = filter?.tz ?? APP_TIMEZONE;
  conds.push(
    ...inWindow(
      tasks.statusSince,
      dateWindow(filter?.statusChangedFrom, filter?.statusChangedTo, tz),
    ),
    ...inWindow(
      tasks.completedAt,
      dateWindow(filter?.completedFrom, filter?.completedTo, tz),
    ),
    ...inWindow(
      tasks.updatedAt,
      dateWindow(filter?.updatedFrom, filter?.updatedTo, tz),
    ),
    ...inWindow(
      tasks.createdAt,
      dateWindow(filter?.createdFrom, filter?.createdTo, tz),
    ),
  );

  // Who touched it: an EXISTS over the activity log — no join, so a task with
  // 20 log rows still comes back once. The window falls back to whichever
  // activity window the caller already stated.
  if (filter?.actor) {
    const w = dateWindow(
      filter.actorFrom ??
        filter.statusChangedFrom ??
        filter.completedFrom ??
        filter.updatedFrom,
      filter.actorTo ??
        filter.statusChangedTo ??
        filter.completedTo ??
        filter.updatedTo,
      tz,
    );
    conds.push(
      sql`exists (select 1 from ${taskLogs} where ${taskLogs.taskId} = ${tasks.id} and ${and(eq(taskLogs.actorId, filter.actor), ...inWindow(taskLogs.at, w))})`,
    );
  }
  return and(...conds);
}

/**
 * The canonical task ordering — `position`, then `createdAt`, then `id`.
 *
 * `position` alone is NOT a total order: it's allocated per (status, parent)
 * group by `nextPosition` and never renumbered on a status change, so any view
 * mixing statuses holds ties. Without a tiebreak those ties resolve to the scan
 * order Postgres happened to feed the Sort — unspecified, and it shifts as the
 * table changes, so deleting one task re-permutes tasks nobody touched.
 *
 * Mirrored client-side by `compareTaskOrder` (`@/lib/task-order`); the two must
 * stay in lockstep.
 */
const TASK_ORDER = [asc(tasks.position), asc(tasks.createdAt), asc(tasks.id)];

/** Most recent status move first — the order that makes `limit` meaningful on
 *  an activity window (truncating TASK_ORDER keeps an arbitrary slice). */
const RECENT_ORDER = [desc(tasks.statusSince), desc(tasks.createdAt), asc(tasks.id)];

/* ---- What a LIST read selects (PLAT-403) --------------------------------
   The three revisable working fields are ~2/3 of a board payload by volume
   (analysisSummary 133 KB + plan 164 KB + summary 128 KB, against 108 KB of
   descriptions, measured at 142 tasks) and are rendered on exactly one
   surface — a single task's detail view, which loads via `getTask` anyway.
   Selecting them in every list read is what put the Neon egress bill at 80%
   of its allowance, so lists leave them in Postgres.

   Derived by omission from the table's own columns rather than enumerated, so
   a newly added column ships in list reads automatically instead of silently
   going missing — and renaming one of these three is a type error here. */
type WorkingField = "analysisSummary" | "plan" | "summary";

const LIST_TASK_COLUMNS = (() => {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { analysisSummary, plan, summary, ...rest } = getTableColumns(tasks);
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return rest;
})();

/** A row from a list read: every task column except the working fields. */
type ListTaskRow = Omit<TaskRow, WorkingField>;

/** Either shape `rowToTask` can map — a full row or a list row. */
type AnyTaskRow = TaskRow | ListTaskRow;

/** The matching rows for a filter, ordered and capped. One query builder for
 *  the tree and flat readers so they can never disagree on scope. */
function taskRows(userId: string, filter?: TaskFilter) {
  const q = db
    // Only a caller that will actually render them pays for the working fields.
    .select(filter?.includeWorkingFields ? getTableColumns(tasks) : LIST_TASK_COLUMNS)
    .from(tasks)
    .where(taskWhere(userId, filter))
    .orderBy(...(filter?.sort === "recent" ? RECENT_ORDER : TASK_ORDER));
  return filter?.limit ? q.limit(filter.limit) : q;
}

/** How many tasks match — the same WHERE, without the cap. Lets a capped read
 *  report "42 of 98" instead of implying it returned everything. */
export async function countTasks(
  userId: string,
  filter?: TaskFilter,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(taskWhere(userId, filter));
  return row?.n ?? 0;
}

/** All of a user's tasks as a nested tree, ordered by status then position.
 *  A filtered read nests whatever matched: a task whose parent didn't match
 *  surfaces as a root rather than vanishing. */
export async function listTasks(
  userId: string,
  filter?: TaskFilter,
): Promise<TaskDTO[]> {
  const [rows, counts, attachments, ctx] = await Promise.all([
    taskRows(userId, filter),
    commentCounts(userId),
    attachmentsByTask(userId),
    codeCtx(userId),
  ]);
  return buildTree(rows, counts, attachments, ctx);
}

/** Flat list (no nesting) — handy for AIs that just want every task. */
export async function listTasksFlat(
  userId: string,
  filter?: TaskFilter,
): Promise<TaskDTO[]> {
  const [rows, counts, attachments, ctx] = await Promise.all([
    taskRows(userId, filter),
    commentCounts(userId),
    attachmentsByTask(userId),
    codeCtx(userId),
  ]);
  return rows.map((r) =>
    rowToTask(r, counts.get(r.id) ?? 0, attachments.get(r.id), ctx),
  );
}

/** Just the ids matching a filter — one short column, no row bodies.
 *  The other half of a delta read: the changed rows say what's new, this says
 *  what still exists, so the client can drop what was deleted without the
 *  server keeping tombstones. ~37 bytes a task against ~1.3 KB for the row. */
export async function listTaskIds(
  userId: string,
  filter?: TaskFilter,
): Promise<string[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    // The watermark is the one filter that must NOT apply here: an unchanged
    // task is exactly what we're trying to confirm still exists.
    .where(taskWhere(userId, { ...filter, updatedAfter: undefined }));
  return rows.map((r) => r.id);
}

/** Query a user's tasks by any combination of filters (flat list).
 *  Self-documenting alias over listTasksFlat — the search entry point. */
export async function searchTasks(
  userId: string,
  filter?: TaskFilter,
): Promise<TaskDTO[]> {
  return listTasksFlat(userId, filter);
}

/**
 * Tasks that matter today: everything in-progress or planned, plus any
 * non-done task that is due today or overdue. Flat list, ready for toMarkdown.
 */
export async function listToday(userId: string): Promise<TaskDTO[]> {
  const all = await listTasksFlat(userId);
  const ref = Date.now();
  return all.filter((t) => {
    if (t.status === "done") return false;
    if (t.status !== "backlog") return true;
    return t.dueDate ? daysAgo(t.dueDate, ref) >= 0 : false;
  });
}

/** A user's tasks with the given ids (flat, position order, comment counts).
 *  Used by the bulk paths to return the refreshed affected set in one shot. */
async function tasksByIds(userId: string, ids: string[]): Promise<TaskDTO[]> {
  if (!ids.length) return [];
  const [rows, counts, ctx] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, ids))
      .orderBy(...TASK_ORDER),
    commentCounts(userId),
    codeCtx(userId),
  ]);
  return rows.map((r) => rowToTask(r, counts.get(r.id) ?? 0, undefined, ctx));
}

export async function getTask(
  handle: string,
  userId: string,
): Promise<{
  task: TaskDTO;
  logs: TaskLogEntry[];
  notes: Note[];
  commits: TaskCommit[];
} | null> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return null;
  const row = (
    await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
  )[0];
  if (!row) return null;
  const [logRows, attachmentRows, noteRows, commitRows, childRows, ctx] =
    await Promise.all([
      db.select().from(taskLogs).where(eq(taskLogs.taskId, id)).orderBy(asc(taskLogs.at)),
      db.select().from(taskAttachments).where(eq(taskAttachments.taskId, id)).orderBy(asc(taskAttachments.createdAt)),
      db.select().from(taskNotes).where(eq(taskNotes.taskId, id)).orderBy(asc(taskNotes.createdAt)),
      db.select().from(taskCommits).where(eq(taskCommits.taskId, id)).orderBy(asc(taskCommits.createdAt)),
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.parentId, id), isNull(tasks.deletedAt)))
        .orderBy(...TASK_ORDER),
      codeCtx(userId),
    ]);
  const cCount = logRows.filter((l) => l.kind === "comment").length;
  // Direct subtasks (one level). Comment counts come from one grouped query so
  // each child's commentCount is truthful, mirroring buildTree's counts map.
  let subtasks: TaskDTO[] | undefined;
  if (childRows.length) {
    const childIds = childRows.map((c) => c.id);
    const countRows = await db
      .select({ taskId: taskLogs.taskId, n: sql<number>`count(*)::int` })
      .from(taskLogs)
      .where(and(inArray(taskLogs.taskId, childIds), eq(taskLogs.kind, "comment")))
      .groupBy(taskLogs.taskId);
    const counts = new Map(countRows.map((r) => [r.taskId, r.n]));
    subtasks = childRows.map((c) => rowToTask(c, counts.get(c.id) ?? 0, undefined, ctx));
  }
  return {
    task: { ...rowToTask(row, cCount, attachmentRows.map(rowToAttachment), ctx), subtasks },
    logs: logRows.map((l) => ({
      id: l.id,
      at: iso(l.at)!,
      kind: l.kind,
      message: l.message,
      author: l.author ?? undefined,
      actorId: l.actorId ?? undefined,
      source: l.source ?? undefined,
    })),
    notes: noteRows.map(rowToNote),
    commits: commitRows.map(rowToCommit),
  };
}

/** Cheap change-cursor for a user's board: moves on any create/update/
 *  move/complete/delete/comment (every mutation bumps updatedAt; deletes
 *  drop the row count). Lets clients poll "did anything change?" without
 *  re-fetching the whole list. One indexed aggregate (tasks_user_idx). */
export async function getChangeCursor(_userId: string): Promise<string> {
  // Team-wide: the board is shared, so the cursor tracks the whole instance.
  //
  // ONE round-trip, not four. This is the single most-called query in the app —
  // every open tab polls it on a timer — and the Neon HTTP driver bills a
  // separate request per query, so four aggregates cost four times the egress
  // for the same ~40 bytes of answer (PLAT-403). Scalar subqueries let Postgres
  // do all four counts in one pass and hand back one row.
  const [row] = await db
    .select({
      c: sql<string>`
        (select count(*) from ${tasks})       || ':' ||
        (select coalesce(extract(epoch from max(${tasks.updatedAt}))::bigint, 0) from ${tasks}) || ':' ||
        (select count(*) from ${boards})      || ':' ||
        (select coalesce(extract(epoch from max(${boards.updatedAt}))::bigint, 0) from ${boards}) || ':' ||
        (select count(*) from ${projects})    || ':' ||
        (select coalesce(extract(epoch from max(${projects.updatedAt}))::bigint, 0) from ${projects}) || ':' ||
        (select count(*) from ${taskNotes})   || ':' ||
        (select coalesce(extract(epoch from max(${taskNotes.updatedAt}))::bigint, 0) from ${taskNotes})
      `,
    })
    // Notes are folded in so a resolve/drag on a canvas note trips the poll for
    // clients with no Liveblocks room open (Notes page, another canvas, MCP).
    .from(sql`(select 1) as _`);
  return row.c;
}

/* -------------------------------------------------------------------- */
/* Writes                                                                */
/* -------------------------------------------------------------------- */

export interface CreateTaskInput {
  title: string;
  status?: TaskStatus;
  /** Assignee refs — each a user id, email, or display name; resolved to
   *  account ids on write (see `resolveAssignees`). */
  assigneeIds?: string[];
  startDate?: string;
  dueDate?: string;
  recurrence?: Recurrence;
  dependsOn?: string[];
  customFields?: Record<string, CustomFieldValue>;
  /** Pin the new task to a canvas Section. Omit it — the canvas surfaces
   *  unpinned tasks in their board's INBOX lane, so only the canvas's own
   *  composers (which know which section you typed into) should set this. */
  canvasSectionId?: string | null;
  /** Which canvas group to file it in — INBOX, THIS WEEK, BACKLOG, LATER or
   *  DONE THIS WEEK. Defaults to INBOX unless the status implies THIS WEEK (a
   *  task born into Analyzing is being worked on now). Ignored when
   *  `canvasSectionId` names a section explicitly. */
  placement?: TaskPlacement;
  /** Older boolean spelling of `placement`: true = thisWeek, false = inbox. */
  thisWeek?: boolean;
  value?: FibPoints;
  difficulty?: FibPoints;
  importance?: Importance;
  description?: string;
  parentId?: string | null;
  boardId?: string | null;
  /** Where in its (status, parent) group the task goes — the fractional sort key
   *  the outline and the canvas already compute for a row's neighbours. Omit it
   *  and the task is appended at the end of the group, which is what every
   *  "add a task" surface wants. Honoured only when the parent asked for is the
   *  parent it actually gets: a position computed among someone's children means
   *  nothing at root. */
  position?: number;
}

/** Next position at the end of the team's (status, parent) group. Team-wide,
 *  so a shared board orders consistently for everyone; `userId` is ignored. */
async function nextPosition(
  _userId: string,
  status: TaskStatus,
  parentId: string | null,
): Promise<number> {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, status),
        isNull(tasks.deletedAt),
        parentId === null
          ? sql`${tasks.parentId} is null`
          : eq(tasks.parentId, parentId),
      ),
    );
  return Number(max) + 1;
}

/** Resolve assignee tokens — each a user id, email, or display name
 *  (case-insensitive) — to canonical `users.id`s. Unknown tokens are dropped.
 *  Order-preserving and de-duped. Lets the picker send ids and an AI/MCP caller
 *  say "assign to Simon" while storage is always account ids. */
export async function resolveAssignees(tokens: string[]): Promise<string[]> {
  if (!tokens.length) return [];
  const rosterRows = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users);
  const byId = new Set(rosterRows.map((r) => r.id));
  const byEmail = new Map(rosterRows.map((r) => [r.email.trim().toLowerCase(), r.id]));
  const byName = new Map(rosterRows.map((r) => [r.name.trim().toLowerCase(), r.id]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const id = byId.has(t)
      ? t
      : byEmail.get(t.toLowerCase()) ?? byName.get(t.toLowerCase());
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Activity-trail fragment for an assignment nobody asked for explicitly. An
 *  implicit write has to be explicable — otherwise "why is this mine?" has no
 *  answer on the timeline. Falls back to the id if the account is gone. */
async function autoAssignNote(userId: string): Promise<string> {
  const [u] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return `👤 Assigned to ${u?.name ?? userId}`;
}

export async function createTask(
  input: CreateTaskInput,
  userId: string,
  author = "You",
): Promise<TaskDTO> {
  const status = input.status ?? "backlog";
  // Nest under any parent that exists (tasks are team-wide); else top-level.
  const parentId =
    input.parentId && (await ownsTask(input.parentId))
      ? input.parentId
      : null;
  // Place on any board that exists (team-wide); else leave unassigned.
  const board =
    input.boardId != null
      ? (
          await db
            .select({ id: boards.id, projectId: boards.projectId })
            .from(boards)
            .where(eq(boards.id, input.boardId))
            .limit(1)
        )[0]
      : undefined;
  const boardId = board?.id ?? null;
  // A task scoped to a board inherits its project (so a code prefix falls back
  // board → project → user). Board-less tasks are user-scoped for now.
  const projectId = board?.projectId ?? null;
  // An explicit position places the task BETWEEN its neighbours — a line opened
  // mid-list in the outline (Shift+Tab out of a description, Enter mid-list) is
  // not a new last item, and appending it moved the row — and the caret with it —
  // to the bottom of the group on the next refetch (TD2-188). Ignored if the
  // requested parent didn't survive resolution above: the key was computed among
  // that parent's children and means nothing in the root group.
  const parentHonoured = (input.parentId ?? null) === parentId;
  const position =
    input.position !== undefined && parentHonoured
      ? input.position
      : await nextPosition(userId, status, parentId);
  // Draw a soft number from the current owner (board → project → creator). The
  // code stays unlocked (soft, shows a trailing "*") until handoff / mint.
  const owner = ownerOf({ boardId, projectId, userId }, userId);
  const seq = await allocSeq(owner.scope, owner.id);
  const ctx = await codeCtx(userId);
  // Born straight into the working part of the spine (Analyzing+)? Then lock the
  // code here. `updateTask`/`moveTask` only lock on a status TRANSITION, and a
  // task created at that status never has one — so without this it would keep a
  // soft code forever while being real work. Same freeze as `computeLockFields`,
  // inlined because there's no row yet to hand it.
  let ref: string | null = null;
  let lockedAt: Date | null = null;
  if (LOCKING_STATUSES.has(status)) {
    const prefix =
      resolvePrefix({ boardId, projectId, userId }, ctx) ??
      (await ensureOwnerCode(owner, userId));
    ref = `${prefix}-${seq}`;
    lockedAt = new Date();
  }
  // Canvas placement. An explicit pin (a canvas composer knows the section you
  // typed into) always wins; otherwise the asked-for group — or, failing that,
  // THIS WEEK when being born straight into work implies it — and anything else
  // stays unpinned and surfaces in its board's INBOX lane.
  const placement =
    askedPlacement(input) ??
    (statusImpliesThisWeek(status) ? "thisWeek" : "inbox");
  const canvasSectionId =
    input.canvasSectionId !== undefined && input.canvasSectionId !== null
      ? input.canvasSectionId
      : await resolvePlacementSection(placement, boardId, projectId);
  const explicitAssignees = await resolveAssignees(input.assigneeIds ?? []);
  // Born straight into work = you own it. `userId` is already a canonical id.
  const assigneeIds = claimsWork(status)
    ? withActor(explicitAssignees, userId)
    : explicitAssignees;
  // Only "auto" if the merge actually added the actor — if the caller named them
  // explicitly there's nothing implicit to explain on the timeline.
  const autoAssigned = assigneeIds.length > explicitAssignees.length;
  const [row] = await db
    .insert(tasks)
    .values({
      userId,
      title: input.title,
      status,
      assigneeIds,
      startDate: input.startDate,
      dueDate: input.dueDate,
      recurrence: input.recurrence,
      dependsOn: input.dependsOn ?? [],
      customFields: input.customFields ?? {},
      canvasSectionId,
      value: input.value,
      difficulty: input.difficulty,
      importance: clampImportance(input.importance ?? 0),
      description: input.description,
      parentId,
      boardId,
      projectId,
      seq,
      position,
      completedAt: status === "done" ? new Date() : null,
      ref,
      refLocked: ref !== null,
      lockedAt,
    })
    .returning();
  await log(
    row.id,
    "created",
    `Created in ${STATUS_LABEL[status]}${ref ? ` · 🔒 Locked as ${ref}` : ""}` +
      (autoAssigned ? ` · ${await autoAssignNote(userId)}` : ""),
    author,
  );
  // Birth is a transition too (from nothing), so a task created straight into
  // Building has an event to credit, same as one that got there by a move.
  await recordStatusEvent({
    taskId: row.id,
    from: null,
    to: status,
    assigneeIds: row.assigneeIds,
    at: row.createdAt,
  });
  // "Add a subtask…" on a finished task means it isn't finished — see
  // `reopenForNewChild`. After the insert, so the trail reads in the order it
  // happened: the child appears, then the parent reopens because of it.
  await reopenForNewChild(parentId, status, author);
  return rowToTask(row, 0, [], ctx);
}

export interface UpdateTaskInput {
  title?: string;
  status?: TaskStatus;
  /** Assignee refs — user id, email, or display name; resolved to ids on write. */
  assigneeIds?: string[];
  startDate?: string | null;
  dueDate?: string | null;
  recurrence?: Recurrence;
  dependsOn?: string[];
  customFields?: Record<string, CustomFieldValue>;
  /** Pin/unpin the task on a canvas Section: an id pins it, `null` releases it
   *  back to its board's INBOX lane. Unlike `customFields` this is a single
   *  scalar, so re-pinning never has to read-modify-write a shared bag. */
  canvasSectionId?: string | null;
  /** Move the task into one of the canvas's groups — THIS WEEK, BACKLOG, LATER,
   *  DONE THIS WEEK, or `"inbox"` to release it back to its board's INBOX lane.
   *  THIS WEEK is implied by a status transition into `THIS_WEEK_STATUSES`, but
   *  only for a task nobody has pinned by hand. Ignored when `canvasSectionId` is
   *  passed alongside it. */
  placement?: TaskPlacement;
  /** Older boolean spelling of `placement`: true = thisWeek, false = inbox. */
  thisWeek?: boolean;
  value?: FibPoints | null;
  difficulty?: FibPoints | null;
  importance?: Importance;
  description?: string | null;
  /* ---- Workflow: revisable free-text fields (null clears).
     UI labels: Analysis / Technical Plan / Summary. ---- */
  analysisSummary?: string | null;
  plan?: string | null;
  summary?: string | null;
}

export async function updateTask(
  handle: string,
  patch: UpdateTaskInput,
  userId: string,
  author = "You",
  /**
   * Optimistic-concurrency token: the `updatedAt` (ISO) the caller last saw.
   * When supplied, the write is rejected with a `ConflictError` if another
   * writer changed the row in the meantime. Omit it for last-write-wins.
   */
  expectedUpdatedAt?: string,
): Promise<TaskDTO | null> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return null;
  const current = (
    await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
  )[0];
  if (!current) return null;
  if (expectedUpdatedAt !== undefined && iso(current.updatedAt) !== expectedUpdatedAt)
    throw new ConflictError(rowToTask(current, 0));

  const now = new Date();
  const values: Record<string, unknown> = { updatedAt: now };
  if (patch.title !== undefined) values.title = patch.title;
  // Assignees: fold together an explicit set and the work-entry claim. Start
  // from the explicit list if given, else the current one, so the actor is
  // merged in and never clobbers whoever is already on it.
  const claimed = claimsWork(patch.status);
  let autoAssigned = false;
  if (patch.assigneeIds !== undefined || claimed) {
    const base =
      patch.assigneeIds !== undefined
        ? await resolveAssignees(patch.assigneeIds)
        : current.assigneeIds;
    const next = claimed ? withActor(base, userId) : base;
    autoAssigned = next.length > base.length;
    values.assigneeIds = next;
  }
  if (patch.startDate !== undefined) values.startDate = patch.startDate;
  if (patch.dueDate !== undefined) values.dueDate = patch.dueDate;
  if (patch.recurrence !== undefined) values.recurrence = patch.recurrence;
  if (patch.dependsOn !== undefined) values.dependsOn = patch.dependsOn;
  if (patch.customFields !== undefined) values.customFields = patch.customFields;
  if (patch.canvasSectionId !== undefined) values.canvasSectionId = patch.canvasSectionId;
  if (patch.value !== undefined) values.value = patch.value;
  if (patch.difficulty !== undefined) values.difficulty = patch.difficulty;
  if (patch.importance !== undefined) values.importance = clampImportance(patch.importance);
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.analysisSummary !== undefined) values.analysisSummary = patch.analysisSummary;
  if (patch.plan !== undefined) values.plan = patch.plan;
  if (patch.summary !== undefined) values.summary = patch.summary;

  const statusChanged =
    patch.status !== undefined && patch.status !== current.status;
  // A parent closes AFTER its children — see `assertSubtreeDone`.
  if (statusChanged && patch.status === "done")
    await assertSubtreeDone(id, current.title);
  let autoLocked: string | null = null;
  if (statusChanged) {
    values.status = patch.status;
    values.statusSince = now;
    // Track completion: stamp on entering "done", clear on leaving it.
    if (patch.status === "done") values.completedAt = now;
    else if (current.status === "done") {
      values.completedAt = null;
      // An archived task is always done, so leaving "done" un-archives it too.
      values.archivedAt = null;
    }
    // Lock the code the first time the task enters the working part of the
    // spine (Analyzing+). Folded into THIS update so the expectedUpdatedAt
    // guard below still holds — no separate mintRef write to trip it. Any entry
    // path (UI picker, AI update_task, prompt) funnels through here.
    if (LOCKING_STATUSES.has(patch.status!) && !current.refLocked) {
      const lockCtx = await codeCtx(userId);
      const lock = await computeLockFields(current, userId, lockCtx);
      if (lock) {
        values.ref = lock.ref;
        values.refLocked = true;
        values.lockedAt = lock.lockedAt;
        values.seq = lock.seq;
        autoLocked = lock.ref;
      }
    }
  }

  // Canvas placement. An explicit `canvasSectionId` wins outright; otherwise an
  // explicit `placement` moves the task to that group, and entering a work status
  // moves an UNPINNED task to THIS WEEK — never one the user parked in a section
  // by hand, because an agent starting work is no reason to yank a card out of
  // the group it was filed in. Recorded so the timeline explains the move.
  let placed: TaskPlacement | null = null;
  if (patch.canvasSectionId === undefined) {
    placed = askedPlacement(patch) ?? null;
    // Leaving done UN-PARKS the card (see `unparkTarget`): a Review card must not
    // be left sitting in DONE THIS WEEK. Checked before the implied rule below —
    // they can't both apply (that one only fires for an unpinned task, and a
    // parked card is pinned), but this reads in the order the rules are meant.
    if (
      placed === null &&
      statusChanged &&
      patch.status !== "done" &&
      current.status === "done"
    )
      placed = await unparkPlacement(current.canvasSectionId, current.boardId);
    if (
      placed === null &&
      statusChanged &&
      statusImpliesThisWeek(patch.status) &&
      current.canvasSectionId === null
    )
      placed = "thisWeek";
  }
  if (placed !== null) {
    const target = await resolvePlacementSection(
      placed,
      current.boardId,
      current.projectId,
    );
    // Already there — or asked for a group this canvas hasn't flagged, in which
    // case `resolvePlacementSection` gives us null and there's nowhere to move
    // it. Either way there's nothing to do or announce. (`inbox` legitimately
    // resolves to null, so it only counts as a move if the task WAS pinned.)
    if (target !== current.canvasSectionId && (target !== null || placed === "inbox"))
      values.canvasSectionId = target;
    else placed = null;
  }

  const [row] = await db
    .update(tasks)
    .set(values)
    // With a token, guard on the updatedAt we just read: if another writer
    // slipped in between the select and this update, 0 rows match. Compared at
    // millisecond precision — a JS Date can't carry the microseconds Postgres
    // now() (used by defaultNow on create) stores, so an exact `=` would never
    // match a freshly-created row.
    .where(
      expectedUpdatedAt !== undefined
        ? and(
            eq(tasks.id, id),
            sql`date_trunc('milliseconds', ${tasks.updatedAt}) = ${current.updatedAt}`,
          )
        : eq(tasks.id, id),
    )
    .returning();
  if (expectedUpdatedAt !== undefined && !row) {
    const fresh = (
      await db.select().from(tasks).where(eq(tasks.id, id))
    )[0];
    throw new ConflictError(fresh ? rowToTask(fresh, 0) : null);
  }

  if (statusChanged)
    await recordStatusEvent({
      taskId: id,
      from: current.status,
      to: patch.status!,
      // Post-update assignees: `claimsWork` may have just added the actor, and
      // the credit rule must read the list as it stands AFTER the write.
      assigneeIds: row.assigneeIds,
      at: now,
    });

  // One activity row summarizing what changed (mirrors bulkUpdate): the status
  // transition and/or the field edits, joined with " · ". Kind stays "status"
  // for a pure status change (preserves its icon), else "updated".
  const logParts: string[] = [];
  if (statusChanged)
    logParts.push(
      `Status: ${STATUS_LABEL[current.status]} → ${STATUS_LABEL[patch.status!]}`,
    );
  if (autoLocked) logParts.push(`🔒 Locked as ${autoLocked}`);
  if (autoAssigned) logParts.push(await autoAssignNote(userId));
  if (placed !== null) logParts.push(PLACEMENT_LOG[placed]);
  const patchMsg = describeBulkPatch(patch);
  if (patchMsg) logParts.push(patchMsg);
  if (logParts.length)
    await log(
      id,
      statusChanged && !patchMsg ? "status" : "updated",
      logParts.join(" · "),
      author,
    );
  const [counts, ctx] = await Promise.all([commentCounts(userId), codeCtx(userId)]);
  return rowToTask(row, counts.get(id) ?? 0, undefined, ctx);
}

/** Move within/across groups: change parent, status, and/or position. */
export async function moveTask(
  handle: string,
  target: {
    parentId?: string | null;
    status?: TaskStatus;
    position?: number;
    boardId?: string | null;
    /** Re-pin (or, with null, unpin) the task on a canvas Section. Moving to a
     *  different board must clear a pin the caller doesn't overwrite: the old
     *  Section is bound to the old board, so leaving the pin would render the
     *  card in a Section for a board it no longer belongs to. */
    canvasSectionId?: string | null;
    /** File it in a canvas group by name instead of by section id — the same
     *  input `createTask`/`updateTask` take. An explicit `canvasSectionId` wins. */
    placement?: TaskPlacement;
    /** Older boolean spelling of `placement`: true = thisWeek, false = inbox. */
    thisWeek?: boolean;
  },
  userId: string,
  author = "You",
): Promise<TaskDTO | null> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return null;
  // The parent may also arrive as a ref (e.g. `move_task INBO-5 --parent INBO-3`).
  if (target.parentId) {
    const parent = await resolveTaskId(target.parentId, userId);
    if (!parent) return null;
    target = { ...target, parentId: parent };
  }
  const current = (
    await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
  )[0];
  if (!current) return null;
  if (target.parentId === id) return null; // can't parent to self
  // Never nest under a task the user doesn't own.
  if (target.parentId && !(await ownsTask(target.parentId, userId))) return null;
  // Never move onto a board the user doesn't own.
  if (target.boardId && !(await ownsBoard(target.boardId, userId))) return null;

  const now = new Date();
  const status = target.status ?? current.status;
  const parentId =
    target.parentId === undefined ? current.parentId : target.parentId;
  const boardId =
    target.boardId === undefined ? current.boardId : target.boardId;
  const statusChanged = status !== current.status;
  // Same rule as `updateTask`: a drag across the done boundary is still a
  // completion, so it can't close over unfinished children either.
  if (statusChanged && status === "done") await assertSubtreeDone(id, current.title);
  const boardChanged = boardId !== current.boardId;
  const position =
    target.position ?? (await nextPosition(userId, status, parentId ?? null));

  // A task follows its board's project (so the code prefix falls back
  // board → project → user). Board-less → user-scoped (projectId null).
  let projectId = current.projectId;
  if (boardChanged) {
    projectId = boardId
      ? (
          await db
            .select({ projectId: boards.projectId })
            .from(boards)
            .where(eq(boards.id, boardId))
            .limit(1)
        )[0]?.projectId ?? null
      : null;
  }

  // While UNLOCKED, a soft code follows the task: if the ref owner changed,
  // re-draw the number from the new owner's counter (leaving a harmless gap in
  // the old). Locked codes are frozen and never touched.
  let seq = current.seq;
  const oldOwner = ownerOf(current, userId);
  // Keep the task's own creator as the user-scope owner (board-less prefix),
  // not whoever is moving it.
  const newOwner = ownerOf({ boardId, projectId, userId: current.userId }, userId);
  if (
    !current.refLocked &&
    (oldOwner.scope !== newOwner.scope || oldOwner.id !== newOwner.id)
  ) {
    seq = await allocSeq(newOwner.scope, newOwner.id);
  }

  // Entering the working part of the spine (Analyzing+) locks the code — same
  // rule as updateTask, so dragging a card into an Analyzing/Building column
  // freezes it. Use the (possibly re-drawn) seq under the new owner's prefix.
  let ref = current.ref;
  let refLocked = current.refLocked;
  let lockedAt = current.lockedAt;
  let autoLocked: string | null = null;
  if (statusChanged && LOCKING_STATUSES.has(status) && !current.refLocked) {
    const ctx = await codeCtx(userId);
    let prefix = resolvePrefix({ ...current, boardId, projectId }, ctx);
    if (!prefix) prefix = await ensureOwnerCode(newOwner, userId);
    if (seq == null) seq = await allocSeq(newOwner.scope, newOwner.id);
    ref = `${prefix}-${seq}`;
    refLocked = true;
    lockedAt = now;
    autoLocked = ref;
  }

  // An explicit pin wins; otherwise a named group; otherwise a board change
  // drops the stale pin, because the Section it pointed at belongs to the board
  // we just left.
  const asked = askedPlacement(target);
  let placed: TaskPlacement | null = null;
  let canvasSectionId: string | null;
  if (target.canvasSectionId !== undefined) {
    canvasSectionId = target.canvasSectionId;
  } else if (asked !== undefined) {
    canvasSectionId = await resolvePlacementSection(asked, boardId, current.projectId);
    placed = canvasSectionId !== current.canvasSectionId ? asked : null;
  } else {
    canvasSectionId = boardChanged ? null : current.canvasSectionId;
  }
  // A drag OUT of done un-parks the card, exactly as `updateTask` does — nothing
  // that isn't done belongs in DONE THIS WEEK. Only when the caller didn't name a
  // destination itself.
  if (
    target.canvasSectionId === undefined &&
    asked === undefined &&
    statusChanged &&
    status !== "done" &&
    current.status === "done"
  ) {
    const unpark = await unparkPlacement(current.canvasSectionId, boardId);
    if (unpark !== null) {
      canvasSectionId = await resolvePlacementSection(unpark, boardId, current.projectId);
      placed = unpark;
    }
  }
  // …and an agent moving the task into work files it on THIS WEEK's board, the
  // same rule `updateTask` applies — but only if nothing else claimed it, so a
  // card the user filed by hand (or a fresh pin above) stays where it is.
  if (
    canvasSectionId === null &&
    statusChanged &&
    statusImpliesThisWeek(status)
  ) {
    canvasSectionId = await resolvePlacementSection("thisWeek", boardId, current.projectId);
    if (canvasSectionId !== null) placed = "thisWeek";
  }

  // Same work-entry claim as updateTask: a move that parks the task in
  // Analyzing/Building from an agent surface records who's on it.
  const assigneeIds = claimsWork(target.status)
    ? withActor(current.assigneeIds, userId)
    : current.assigneeIds;
  const autoAssigned = assigneeIds.length > current.assigneeIds.length;

  const [row] = await db
    .update(tasks)
    .set({
      status,
      parentId,
      boardId,
      projectId,
      canvasSectionId,
      assigneeIds,
      seq,
      ref,
      refLocked,
      lockedAt,
      position,
      statusSince: statusChanged ? now : current.statusSince,
      // Keep completion in sync when a drag crosses the "done" boundary.
      completedAt: statusChanged
        ? status === "done"
          ? now
          : null
        : current.completedAt,
      updatedAt: now,
    })
    .where(eq(tasks.id, id))
    .returning();
  if (statusChanged)
    await recordStatusEvent({
      taskId: id,
      from: current.status,
      to: status,
      assigneeIds: row.assigneeIds,
      at: now,
    });
  const moveNotes = [
    ...(autoLocked ? [`🔒 Locked as ${autoLocked}`] : []),
    ...(autoAssigned ? [await autoAssignNote(userId)] : []),
    ...(placed !== null ? [PLACEMENT_LOG[placed]] : []),
  ];
  if (moveNotes.length) await log(id, "updated", moveNotes.join(" · "), author);

  if (target.parentId !== undefined && target.parentId !== current.parentId) {
    const parentTitle = target.parentId
      ? (
          await db
            .select()
            .from(tasks)
            .where(eq(tasks.id, target.parentId))
        )[0]?.title
      : null;
    await log(
      id,
      "nested",
      parentTitle ? `Nested under “${parentTitle}”` : "Un-nested to top level",
      author,
    );
    // Dropping open work onto a finished parent reopens it — the same mirror rule
    // `createTask` applies (see `reopenForNewChild`). Uses the task's NEW status,
    // since this same call may have changed it.
    await reopenForNewChild(parentId, status, author);
  } else if (boardChanged) {
    const boardName = boardId
      ? (
          await db
            .select({ name: boards.name })
            .from(boards)
            .where(eq(boards.id, boardId))
        )[0]?.name
      : null;
    await log(
      id,
      "moved",
      boardName ? `Moved to board “${boardName}”` : "Removed from board",
      author,
    );
  } else if (statusChanged) {
    await log(id, "moved", `Moved to ${STATUS_LABEL[status]}`, author);
  }
  // A pure re-sort within the same status/parent/board is noise — no log row.
  const [counts, ctx] = await Promise.all([commentCounts(userId), codeCtx(userId)]);
  return rowToTask(row, counts.get(id) ?? 0, undefined, ctx);
}

/** How many unfinished subtasks a refusal names before it says "+N more". */
const OPEN_SUBTASKS_LISTED = 3;

/** Depth ceiling on the subtree walk below. Not a real limit — nesting runs two
 *  or three deep — but a corrupt `parent_id` cycle would otherwise make the
 *  recursion spin forever, and a CTE has no `seen` set to fall back on. */
const MAX_SUBTREE_DEPTH = 20;

/** One unfinished task under some root, with the root it blocks. */
interface OpenDescendant {
  rootId: string;
  id: string;
  title: string;
  status: TaskStatus;
  depth: number;
}

/**
 * The unfinished (and unarchived) descendants of each of `rootIds`, DEEPEST
 * FIRST — one query for the whole set, however many roots and however deep.
 *
 * One statement rather than a walk per level per root: a 50-task bulk completion
 * would otherwise be 50 × depth round trips to Neon, on a board that just spent a
 * commit cutting egress. Deepest-first is what `completeTask({ withSubtasks })`
 * needs to close a branch from the leaves up, and costs the refusal path nothing.
 *
 * Archived descendants are excluded: archiving cascades over a subtree regardless
 * of status (see `archiveTask`), so they're off the board and can't be what's
 * holding a parent open.
 */
async function openDescendants(
  rootIds: string[],
): Promise<Map<string, OpenDescendant[]>> {
  const out = new Map<string, OpenDescendant[]>();
  if (!rootIds.length) return out;
  // Raw CTE (the same shape `archiveTask` uses to cascade): `rootIds` and the
  // depth cap still ride as bound parameters via the embedded `inArray`.
  const res = await db.execute(sql`
    WITH RECURSIVE sub AS (
      SELECT id, parent_id, title, status, archived_at, deleted_at, position,
             created_at, parent_id AS root_id, 1 AS depth
        FROM ${tasks}
       WHERE ${inArray(tasks.parentId, rootIds)}
      UNION ALL
      SELECT c.id, c.parent_id, c.title, c.status, c.archived_at, c.deleted_at,
             c.position, c.created_at, sub.root_id, sub.depth + 1
        FROM ${tasks} c JOIN sub ON c.parent_id = sub.id
       WHERE sub.depth < ${MAX_SUBTREE_DEPTH}
    )
    SELECT root_id, id, title, status, depth FROM sub
     WHERE status <> 'done' AND archived_at IS NULL AND deleted_at IS NULL
     ORDER BY depth DESC, position, created_at, id
  `);
  const rows = (res as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
  for (const row of rows) {
    const item: OpenDescendant = {
      rootId: String(row.root_id),
      id: String(row.id),
      title: String(row.title),
      status: row.status as TaskStatus,
      depth: Number(row.depth),
    };
    const list = out.get(item.rootId);
    if (list) list.push(item);
    else out.set(item.rootId, [item]);
  }
  return out;
}

/**
 * The refusal itself: a sentence for the person, plus the ids for the client.
 *
 * `details` is what lets the UI offer to finish the branch instead of just
 * reporting the wall — see `RuleDetails` in api.ts and the `open_subtasks` toast.
 */
function openSubtasksError(
  id: string,
  title: string,
  open: OpenDescendant[],
): ValidationError {
  const listed = open
    .slice(0, OPEN_SUBTASKS_LISTED)
    .map((t) => `“${t.title}” (${STATUS_LABEL[t.status]})`);
  const rest = open.length - listed.length;
  return new ValidationError(
    `Can’t complete “${title}”: ${open.length} subtask${open.length === 1 ? " isn’t" : "s aren’t"} done — ${listed.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`,
    {
      code: "open_subtasks",
      // The task the refusal is ABOUT, so a client can offer to finish the
      // branch without having to remember what it just tried to complete —
      // the write may have come from a drag or a keypress three layers down.
      taskId: id,
      taskTitle: title,
      openIds: open.map((t) => t.id),
      openCount: open.length,
    },
  );
}

/**
 * Refuse to complete a task while anything beneath it is unfinished.
 *
 * Done on a parent is a claim about its whole subtree, not about the parent row:
 * subtasks are how a piece of work is broken down, so they finish FIRST and the
 * parent closes after them. A parent marked done over open children makes the
 * board lie twice — the branch reads as finished, and the children, which have
 * no pin of their own, inherit the parent's placement and follow it into DONE
 * THIS WEEK while sitting in Review.
 *
 * Enforced here rather than in `completeTask` because completing isn't one code
 * path: `completeTask`, a status patch through `updateTask`, a drag across the
 * done boundary in `moveTask`, DELETE on a Review card (`deletionOf`), and
 * `bulkUpdate` all write the same status. This is the one place they meet.
 *
 * The MIRROR of this rule lives in `reopenForNewChild`: this side stops a parent
 * closing over open work, that side stops open work being attached to a closed
 * parent. Both are needed, or the same bad state just arrives from the other end.
 *
 * Only ENTERING done is checked. Reopening a parent, editing a done task, and
 * archiving (which cascades by design) are all untouched.
 */
async function assertSubtreeDone(id: string, title: string): Promise<void> {
  const open = (await openDescendants([id])).get(id) ?? [];
  if (open.length) throw openSubtasksError(id, title, open);
}

/**
 * Is this task PARKED — pinned to the DONE THIS WEEK lane for its board?
 *
 * Asked by the un-parking rule below. Resolved through
 * `resolvePlacementSection` (a read; it never writes canvas nodes) rather than
 * by parsing the id, so it recognises both a real lane node and the derived id
 * the server pins to before the canvas has drawn one.
 */
async function isParkedInDone(
  pin: string | null,
  boardId: string | null,
  projectId: string | null = null,
): Promise<boolean> {
  if (!pin) return false;
  return pin === (await resolvePlacementSection("doneThisWeek", boardId, projectId));
}

/**
 * Which bucket a task belongs in once it LEAVES done — `null` for "leave it".
 *
 * Only ever moves a card OUT of DONE THIS WEEK: a card that isn't done has no
 * business in a tray called DONE THIS WEEK, which is the exact complaint that
 * started this rule (a Review card under the done band). The implied "entering
 * work files it on THIS WEEK" rule can't do this job — it deliberately spares any
 * task pinned by hand, and a parked card IS pinned. A pin anywhere else is left
 * alone: that's a filing decision someone made, and reopening is no reason to
 * overrule it.
 *
 * THIS WEEK is the destination when it exists, but it's HAND-MADE — a canvas may
 * have no starred group at all, and then `resolvePlacementSection` rightly gives
 * back nothing. Falling back to INBOX matters more than it looks: without it the
 * card simply stayed parked, so on exactly the canvases that have no THIS WEEK
 * group, the rule quietly did nothing. Untriaged is always available (it IS the
 * absence of a pin), and it's honest — the card needs re-filing anyway.
 */
async function unparkPlacement(
  pin: string | null,
  boardId: string | null,
  projectId: string | null = null,
): Promise<TaskPlacement | null> {
  if (!(await isParkedInDone(pin, boardId, projectId))) return null;
  return (await resolvePlacementSection("thisWeek", boardId, projectId)) !== null
    ? "thisWeek"
    : "inbox";
}

/**
 * The mirror of `assertSubtreeDone`: attaching unfinished work to a FINISHED
 * parent reopens the parent.
 *
 * `assertSubtreeDone` stops a parent closing over open children, but on its own
 * it only guards one direction — nothing stopped the same state arriving from
 * the other end, and that end is the everyday one: "Add a subtask…" on a done
 * task (`createTask`), or dragging an open card onto a done parent
 * (`moveTask`). Neither looked at the parent's status.
 *
 * Reopening rather than refusing is the honest reading of the rule: if there's
 * unfinished work under it, the parent is not finished. So it goes back to
 * Review (the status it must have passed through to be completed), leaves the
 * DONE THIS WEEK tray with `unparkTarget`, and says so on its timeline. A DONE
 * child attaches without disturbing anything — that's just recording work that
 * was already finished.
 */
async function reopenForNewChild(
  parentId: string | null,
  childStatus: TaskStatus,
  author: string,
): Promise<void> {
  if (!parentId || childStatus === "done") return;
  const [parent] = await db.select().from(tasks).where(eq(tasks.id, parentId));
  if (!parent || parent.status !== "done") return;

  const now = new Date();
  const unpark = await unparkPlacement(
    parent.canvasSectionId,
    parent.boardId,
    parent.projectId,
  );
  const unparked =
    unpark !== null
      ? await resolvePlacementSection(unpark, parent.boardId, parent.projectId)
      : null;
  await db
    .update(tasks)
    .set({
      status: "review",
      statusSince: now,
      completedAt: null,
      // An archived task is always done, so leaving done un-archives it — the
      // same rule `updateTask` applies on that transition.
      archivedAt: null,
      // `unpark` of "inbox" resolves to a null pin, which IS the move.
      ...(unpark !== null ? { canvasSectionId: unparked } : {}),
      updatedAt: now,
    })
    .where(eq(tasks.id, parentId));
  await recordStatusEvent({
    taskId: parentId,
    from: "done",
    to: "review",
    assigneeIds: parent.assigneeIds,
    at: now,
  });
  await log(
    parentId,
    "reopened",
    [
      `Reopened (${STATUS_LABEL.review}) — unfinished work was nested under it`,
      ...(unpark !== null ? [PLACEMENT_LOG[unpark]] : []),
    ].join(" · "),
    author,
  );
}

/**
 * Complete or reopen (reopen sends it back to To Do, like the UI).
 *
 * `withSubtasks` closes the whole BRANCH: every unfinished descendant first, then
 * the task. It exists because `assertSubtreeDone` is otherwise a wall with no
 * door — DELETE on a Review card means "complete", so a parent with open children
 * could be refused with no way forward — and because closing thirteen subtasks
 * one at a time to finish one branch is not a workflow.
 *
 * Deliberately opt-in, never implied: completing a parent must not quietly mark
 * work done that nobody finished, so the caller (a human confirming a prompt, or
 * an agent that was told to) has to ask for it by name.
 *
 * The descendants go through this same function, DEEPEST FIRST (the order
 * `openDescendants` returns), so each one gets its own status event, log line and
 * placement move, and each passes `assertSubtreeDone` on its own merits — no
 * bypass flag, no second write path, and a mid-branch failure leaves the leaves
 * done rather than a parent lying about them.
 */
export async function completeTask(
  handle: string,
  done = true,
  userId: string,
  author = "You",
  opts: { withSubtasks?: boolean } = {},
): Promise<TaskDTO | null> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return null;
  if (done && opts.withSubtasks) {
    const open = (await openDescendants([id])).get(id) ?? [];
    for (const child of open) await completeTask(child.id, true, userId, author);
  }
  return updateTask(
    id,
    { status: done ? "done" : "todo" },
    userId,
    author,
  ).then(async (t) => {
    if (t)
      await log(
        id,
        done ? "done" : "reopened",
        done ? "Completed" : "Reopened (Planned)",
        author,
      );
    return t;
  });
}

/** Archive or un-archive a task, cascading to its whole subtree. Only a done
 *  task can be archived (its descendants come along regardless of their own
 *  status, so nothing is orphaned off the board); un-archive restores the
 *  subtree intact. Hides/reveals the task across every active view. */
export async function archiveTask(
  handle: string,
  archived = true,
  userId: string,
  author = "You",
): Promise<TaskDTO | null> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return null;
  const current = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
  if (!current) return null;
  if (archived && current.status !== "done")
    throw new ValidationError("Only done tasks can be archived");

  const now = new Date();
  // Cascade to the full subtree so children aren't left invisible (the board
  // only renders top-level tasks + their present parents).
  await db.execute(sql`
    WITH RECURSIVE sub AS (
      SELECT ${id}::text AS id
      UNION ALL
      SELECT t.id FROM ${tasks} t JOIN sub ON t.parent_id = sub.id
    )
    UPDATE ${tasks} SET archived_at = ${archived ? now : null}, updated_at = ${now}
    WHERE id IN (SELECT id FROM sub)
  `);
  await log(id, "updated", archived ? "Archived" : "Un-archived", author);

  const [counts, ctx] = await Promise.all([commentCounts(userId), codeCtx(userId)]);
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
  return row ? rowToTask(row, counts.get(id) ?? 0, undefined, ctx) : null;
}

/** Archive every done task in scope (a board, a project, or everywhere when no
 *  scope is given), cascading each to its subtree. Returns how many done tasks
 *  were archived. */
export async function archiveAllDone(
  userId: string,
  scope: { boardId?: string; projectId?: string } = {},
  author = "You",
): Promise<number> {
  const conds: (SQL | undefined)[] = [
    eq(tasks.status, "done"),
    isNull(tasks.archivedAt),
    isNull(tasks.deletedAt),
  ];
  if (scope.boardId) conds.push(eq(tasks.boardId, scope.boardId));
  if (scope.projectId) conds.push(eq(tasks.projectId, scope.projectId));
  const doneRoots = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(...conds));
  for (const { id } of doneRoots) {
    await archiveTask(id, true, userId, author);
  }
  return doneRoots.length;
}

export async function addComment(
  handle: string,
  message: string,
  userId: string,
  author = "You",
): Promise<TaskLogEntry | null> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return null;
  const ctx = currentLogContext();
  const [row] = await db
    .insert(taskLogs)
    .values({
      taskId: id,
      kind: "comment",
      message,
      author,
      actorId: ctx?.actorId,
      source: ctx?.source,
    })
    .returning();
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, id));
  return { id: row.id, at: iso(row.at)!, kind: "comment", message: row.message };
}

/**
 * DELETE a task — into the Trash, not out of Postgres (TD2-196).
 *
 * The row stays exactly where it is and keeps its id, its ref, its logs, its
 * attachments and its place in the tree; `deletedAt` is what takes it off every
 * surface. Two fences make that stick, and they're the same two archiving uses:
 * `taskWhere` drops it from every list/search/digest read, and `resolveTaskId`
 * refuses its handle, so no later write can touch a task that's in the bin.
 *
 * Cascades over the SUBTREE, like `archiveTask`. Deleting a parent used to
 * promote its children to top level, which is the only thing you can do when the
 * parent is about to stop existing — but it loses the shape of the work, and
 * there's nothing to promote them back into on the way out. Now the branch goes
 * in whole and `restoreTask` brings it back whole.
 *
 * Nothing here is irreversible: `purgeTask` / `emptyTrash` are the only calls
 * that drop rows and blobs, and they only accept a task that's already in the
 * Trash.
 */
export async function deleteTask(
  handle: string,
  userId: string,
  author = "You",
): Promise<boolean> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return false;
  const now = new Date();
  // `deleted_at IS NULL` on the UPDATE so a descendant already in the bin keeps
  // the stamp it went in with — its own row in the Trash, its own place in the
  // "deleted at" order.
  await db.execute(sql`
    WITH RECURSIVE sub AS (
      SELECT ${id}::text AS id
      UNION ALL
      SELECT t.id FROM ${tasks} t JOIN sub ON t.parent_id = sub.id
    )
    UPDATE ${tasks} SET deleted_at = ${now}, updated_at = ${now}
    WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL
  `);
  await log(id, "updated", "Deleted — moved to Trash", author);
  return true;
}

/**
 * Bring a task back from the Trash, with its subtree.
 *
 * A restore has to land somewhere VISIBLE, and there's one way it wouldn't: the
 * task's parent may still be in the bin (a child can be restored on its own, by
 * handle, from the API or MCP), and the boards only render a task whose parent is
 * present. So a restored task with a trashed parent is un-nested to top level and
 * re-positioned at the end of its status group — the same repair `deleteTask`
 * used to do on the way out, now on the way back in, where it's recoverable.
 */
export async function restoreTask(
  handle: string,
  userId: string,
  author = "You",
): Promise<TaskDTO | null> {
  const id = await resolveTaskId(handle, userId, { includeTrashed: true });
  if (!id) return null;
  const current = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
  if (!current) return null;
  if (!current.deletedAt) return rowToTask(current, 0, undefined, await codeCtx(userId));

  const now = new Date();
  await db.execute(sql`
    WITH RECURSIVE sub AS (
      SELECT ${id}::text AS id
      UNION ALL
      SELECT t.id FROM ${tasks} t JOIN sub ON t.parent_id = sub.id
    )
    UPDATE ${tasks} SET deleted_at = NULL, updated_at = ${now}
    WHERE id IN (SELECT id FROM sub)
  `);

  let orphaned = false;
  if (current.parentId) {
    const parent = (
      await db
        .select({ deletedAt: tasks.deletedAt })
        .from(tasks)
        .where(eq(tasks.id, current.parentId))
    )[0];
    if (!parent || parent.deletedAt) {
      orphaned = true;
      await db
        .update(tasks)
        .set({
          parentId: null,
          position: await nextPosition(userId, current.status, null),
          updatedAt: now,
        })
        .where(eq(tasks.id, id));
    }
  }

  await log(
    id,
    "updated",
    `Restored from Trash${orphaned ? " · un-nested to top level (its parent is still deleted)" : ""}`,
    author,
  );
  const [counts, ctx] = await Promise.all([commentCounts(userId), codeCtx(userId)]);
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
  return row ? rowToTask(row, counts.get(id) ?? 0, undefined, ctx) : null;
}

/** The ids in a task's subtree, itself included — one statement, any depth. */
async function subtreeIds(id: string): Promise<string[]> {
  const res = await db.execute(sql`
    WITH RECURSIVE sub AS (
      SELECT ${id}::text AS id
      UNION ALL
      SELECT t.id FROM ${tasks} t JOIN sub ON t.parent_id = sub.id
    )
    SELECT id FROM sub
  `);
  const rows = (res as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
  return rows.map((r) => String(r.id));
}

/** Drop the Vercel Blob objects behind a set of tasks' attachments. The DB
 *  cascade takes the rows; the files are ours to clean up. */
async function purgeBlobs(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db
    .select({ url: taskAttachments.url })
    .from(taskAttachments)
    .where(inArray(taskAttachments.taskId, ids));
  if (rows.length) await delBlobs(rows.map((a) => a.url));
}

/**
 * Delete a task FOREVER — rows, logs, attachment rows and blobs, whole subtree.
 *
 * Only from the Trash: permanent deletion is the second of two deliberate steps,
 * and requiring the first one is what stops a stray DELETE (a keypress, a bulk
 * op, an agent) from being unrecoverable. It also means the subtree this drops is
 * one a person has already seen listed in the bin.
 */
export async function purgeTask(handle: string, userId: string): Promise<boolean> {
  const id = await resolveTaskId(handle, userId, { includeTrashed: true });
  if (!id) return false;
  const current = (
    await db.select({ deletedAt: tasks.deletedAt }).from(tasks).where(eq(tasks.id, id))
  )[0];
  if (!current) return false;
  if (!current.deletedAt)
    throw new ValidationError(
      "Only a deleted task can be deleted forever — delete it first, then empty it from the Trash",
    );
  const ids = await subtreeIds(id);
  await purgeBlobs(ids);
  const res = await db.delete(tasks).where(inArray(tasks.id, ids)).returning({ id: tasks.id });
  return res.length > 0;
}

/**
 * EMPTY THE TRASH — the big button. Every deleted task in scope (a board, a
 * project, or everywhere when no scope is given) is gone for good. Returns how
 * many rows were dropped.
 *
 * One pass over `deleted_at IS NOT NULL` rather than a walk per subtree: deleting
 * cascades, and a live task can never sit under a deleted one (`resolveTaskId`
 * won't resolve a trashed parent to nest under), so the trashed set IS whole
 * subtrees and can be dropped in a single statement.
 */
export async function emptyTrash(
  userId: string,
  scope: { boardId?: string; projectId?: string } = {},
): Promise<number> {
  const conds: (SQL | undefined)[] = [isNotNull(tasks.deletedAt)];
  if (scope.boardId) conds.push(eq(tasks.boardId, scope.boardId));
  if (scope.projectId) conds.push(eq(tasks.projectId, scope.projectId));
  const rows = await db.select({ id: tasks.id }).from(tasks).where(and(...conds));
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  await purgeBlobs(ids);
  const res = await db.delete(tasks).where(inArray(tasks.id, ids)).returning({ id: tasks.id });
  return res.length;
}

/* -------------------------------------------------------------------- */
/* Bulk operations                                                       */
/* -------------------------------------------------------------------- */

/** Where a task can be moved to (mirrors moveTask's `target`). */
export type MoveTarget = {
  parentId?: string | null;
  status?: TaskStatus;
  position?: number;
  boardId?: string | null;
  /** Canvas Section pin. State it to place the card; omitting it on a board
   *  change means "clear it" (see `moveTask`) — which is exactly why a
   *  cross-board drop has to say what it wants. */
  canvasSectionId?: string | null;
  /** File it in a canvas group BY NAME instead of by section id — `moveTask`
   *  resolves it against the (possibly new) board. Already accepted end to end
   *  (`moveTaskSchema` → `moveTask`); stated here so a bulk `move` op can carry a
   *  bucket, which is how the Boards view files and positions a card in one op. */
  placement?: TaskPlacement;
};

/** One step in a `bulkApply` batch. Executed in array order. */
export type BulkOp =
  | { op: "create"; input: CreateTaskInput }
  | { op: "update"; id: string; patch: UpdateTaskInput }
  | { op: "move"; id: string; target: MoveTarget }
  | { op: "complete"; id: string; done?: boolean }
  | { op: "comment"; id: string; message: string }
  | { op: "archive"; id: string; archived?: boolean }
  | { op: "delete"; id: string };

// The per-op result shape and the batch cap live in `@/lib/bulk` — the browser
// needs both (to chunk, and to spot failed ops) and must not import this module.
// Re-exported here so existing `db/service` importers keep working.
export { MAX_BULK_OPS, type OpResult };

/** Human summary of the constant (per-batch) part of a bulk patch — the
 *  per-task status transition is appended separately by `bulkUpdate`. */
function describeBulkPatch(patch: UpdateTaskInput): string {
  const parts: string[] = [];
  // Title & description edits are intentionally NOT logged: the UI autosaves
  // them on a debounce, so every flush would otherwise write a near-identical
  // activity row — a wall of noise during a single typing session.
  if (patch.assigneeIds !== undefined)
    parts.push(
      patch.assigneeIds.length
        ? `Assignees → ${patch.assigneeIds.length}`
        : "Assignees cleared",
    );
  if (patch.value !== undefined)
    parts.push(patch.value == null ? "Value cleared" : `Value → ${patch.value}`);
  if (patch.difficulty !== undefined)
    parts.push(
      patch.difficulty == null ? "Difficulty cleared" : `Difficulty → ${patch.difficulty}`,
    );
  if (patch.importance !== undefined) parts.push(`Importance → ${patch.importance}`);
  if (patch.startDate !== undefined)
    parts.push(patch.startDate == null ? "Start date cleared" : `Start → ${patch.startDate}`);
  if (patch.dueDate !== undefined)
    parts.push(patch.dueDate == null ? "Due date cleared" : `Due → ${patch.dueDate}`);
  if (patch.recurrence !== undefined) parts.push(`Recurrence → ${patch.recurrence}`);
  if (patch.dependsOn !== undefined) parts.push("Dependencies updated");
  if (patch.customFields !== undefined) parts.push("Custom fields updated");
  if (patch.canvasSectionId !== undefined)
    parts.push(patch.canvasSectionId == null ? "Removed from canvas section" : "Moved to canvas section");
  // Workflow fields — carried by the single-task edit path (not bulk).
  if (patch.plan !== undefined)
    parts.push(patch.plan == null ? "Plan cleared" : "Plan updated");
  if (patch.summary !== undefined)
    parts.push(patch.summary == null ? "Summary cleared" : "Summary written");
  if (patch.analysisSummary !== undefined)
    parts.push(patch.analysisSummary == null ? "Analysis cleared" : "Analysis recorded");
  return parts.join(" · ");
}

/**
 * Apply the SAME patch to many tasks in one shot — the efficient 80% case
 * ("assign these to Simon", "tag these #work", "move these to Planned").
 * Genuinely bulk: one SELECT to resolve ownership, one UPDATE, one batched
 * INSERT for the activity trail (kind "updated"). Tasks the user doesn't own
 * are silently skipped (returned in `skipped`), matching the single-task
 * "invisible if not yours" convention. A `status: "done"` patch also skips any
 * task with unfinished subtasks, for the reason `assertSubtreeDone` gives —
 * skipped rather than fatal, so one bad parent doesn't sink the batch.
 *
 * Note: because the whole set is updated in a single statement, `statusSince`
 * (and `completedAt` when status changes) is re-stamped for every matched row,
 * even one already in the target status — an acceptable bulk-touch semantic.
 * Reorder/nest/board moves are deliberately NOT here — that's `bulkApply`'s
 * `move` op.
 */
export async function bulkUpdate(
  userId: string,
  ids: string[],
  patch: UpdateTaskInput,
  author = "You",
): Promise<{
  updated: number;
  /** Ids the caller can't see (not theirs) — nothing to report to a person. */
  skipped: string[];
  /** Ids a RULE stopped, with enough to explain it. Currently only a completion
   *  held up by unfinished subtasks (`assertSubtreeDone`). */
  blocked: { id: string; title: string; openCount: number }[];
  tasks: TaskDTO[];
}> {
  // 1. Resolve each handle (UUID or ref) to a canonical UUID the user owns;
  //    anything that doesn't resolve is reported as skipped, not silently lost.
  const resolved = await Promise.all(ids.map((h) => resolveTaskId(h, userId)));
  const skipped = ids.filter((_, i) => !resolved[i]);
  const resolvedIds = resolved.filter((x): x is string => x !== null);
  // Grab prior status + assignees for the activity log (resolution already
  // scoped to user); the assignees tell us which rows the claim below touched.
  let owned = resolvedIds.length
    ? await db
        .select({
          id: tasks.id,
          status: tasks.status,
          // Named in the `blocked` report below, so a caller can say WHICH task
          // still has unfinished subtasks without a second read.
          title: tasks.title,
          assigneeIds: tasks.assigneeIds,
          // For THIS WEEK placement below: the target depends on each task's own
          // board, and the status-implied move only applies to unpinned tasks.
          boardId: tasks.boardId,
          // Needed to pick a board-less task's canvas — see the grouping below.
          projectId: tasks.projectId,
          canvasSectionId: tasks.canvasSectionId,
        })
        .from(tasks)
        .where(inArray(tasks.id, resolvedIds))
    : [];
  // A bulk completion obeys the same rule as a single one — a parent closes
  // after its children (`assertSubtreeDone`). This path writes status in one
  // UPDATE rather than through `updateTask`, so the check has to happen here too,
  // or "select all → Done" would be the one way round it.
  //
  // A blocked parent is REPORTED, not fatal: the rest of the selection is
  // legitimate and shouldn't be lost to one bad id. It gets its own `blocked`
  // list rather than being lumped into `skipped`, which means "not yours" — a
  // caller has to be able to tell "you can't see it" from "finish its subtasks
  // first", and only the second one is worth showing a person. Dropped from
  // `owned`, not just from the UPDATE, so the locking and placement passes below
  // leave a blocked task completely alone.
  const blocked: { id: string; title: string; openCount: number }[] = [];
  if (patch.status === "done" && owned.length) {
    // Rows already done aren't entering done, so nothing to check.
    const entering = owned.filter((r) => r.status !== "done");
    const open = await openDescendants(entering.map((r) => r.id));
    for (const row of entering) {
      const openUnder = open.get(row.id);
      if (openUnder?.length)
        blocked.push({
          id: row.id,
          title: row.title,
          openCount: openUnder.length,
        });
    }
    if (blocked.length) {
      const ids = new Set(blocked.map((b) => b.id));
      owned = owned.filter((r) => !ids.has(r.id));
    }
  }

  const ownedIds = owned.map((r) => r.id);
  if (!ownedIds.length) return { updated: 0, skipped, blocked, tasks: [] };

  // 2. Build the column patch — same field set + null-clearing as updateTask.
  const now = new Date();
  const values: Record<string, unknown> = { updatedAt: now };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.assigneeIds !== undefined)
    values.assigneeIds = await resolveAssignees(patch.assigneeIds);
  if (patch.startDate !== undefined) values.startDate = patch.startDate;
  if (patch.dueDate !== undefined) values.dueDate = patch.dueDate;
  if (patch.recurrence !== undefined) values.recurrence = patch.recurrence;
  if (patch.dependsOn !== undefined) values.dependsOn = patch.dependsOn;
  if (patch.customFields !== undefined) values.customFields = patch.customFields;
  if (patch.canvasSectionId !== undefined) values.canvasSectionId = patch.canvasSectionId;
  if (patch.value !== undefined) values.value = patch.value;
  if (patch.difficulty !== undefined) values.difficulty = patch.difficulty;
  if (patch.importance !== undefined) values.importance = clampImportance(patch.importance);
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.status !== undefined) {
    values.status = patch.status;
    values.statusSince = now;
    values.completedAt = patch.status === "done" ? now : null;
    // Leaving "done" un-archives (an archived task is always done).
    if (patch.status !== "done") values.archivedAt = null;
  }
  // Same work-entry claim as updateTask/moveTask. With an explicit list the
  // merge is a constant; without one each row keeps its OWN assignees, so the
  // merge has to happen per-row — expressed in SQL to stay inside the single
  // bulk UPDATE below rather than degenerating into a write per task.
  const claimed = claimsWork(patch.status);
  if (claimed) {
    values.assigneeIds =
      patch.assigneeIds !== undefined
        ? withActor(values.assigneeIds as string[], userId)
        : sql`CASE WHEN ${userId} = ANY(${tasks.assigneeIds})
                   THEN ${tasks.assigneeIds}
                   ELSE array_append(${tasks.assigneeIds}, ${userId}) END`;
  }

  // 3. One UPDATE for the whole owned set.
  const rows = await db
    .update(tasks)
    .set(values)
    .where(inArray(tasks.id, ownedIds))
    .returning();

  // 3b. Lock the code of anything this moved into the working spine (Analyzing+)
  //     that wasn't locked already — the same freeze `updateTask`/`moveTask` do,
  //     so a task can't reach committed work with a soft code whichever path it
  //     took. Can't ride the bulk UPDATE above: every ref is per-task (its own
  //     prefix + seq), so it's one write each — but only for those that need it,
  //     and only ever once per task.
  const codes = await codeCtx(userId);
  const relocked = new Map<string, TaskRow>();
  if (patch.status !== undefined && LOCKING_STATUSES.has(patch.status)) {
    for (const r of rows) {
      const lock = await computeLockFields(r, userId, codes);
      if (!lock) continue;
      const [row] = await db
        .update(tasks)
        .set({
          ref: lock.ref,
          refLocked: true,
          lockedAt: lock.lockedAt,
          seq: lock.seq,
        })
        .where(and(eq(tasks.id, r.id), eq(tasks.refLocked, false)))
        .returning();
      if (row) relocked.set(r.id, row);
    }
  }

  // 3c. Canvas placement — the same rules as `updateTask`: an explicit
  //     `canvasSectionId` wins, else an explicit `placement` moves them to that
  //     group, else entering a work status moves the tasks nobody pinned by hand
  //     to THIS WEEK. Can't ride the bulk UPDATE either: the target section is
  //     per BOARD, so it's one write per distinct board (bounded by the board
  //     count, not the task count) — and only for the tasks that need moving.
  /** Task id → the group it was moved to, for the trail rows. */
  const placed = new Map<string, TaskPlacement>();
  /** Task id → its new pin, for the returned shape (the bulk UPDATE's `rows`
   *  were read before these writes, so they still carry the old one). */
  const repinned = new Map<string, string | null>();
  if (patch.canvasSectionId === undefined) {
    const asked = askedPlacement(patch);
    const target = asked ?? (statusImpliesThisWeek(patch.status) ? "thisWeek" : null);
    if (target !== null) {
      // A status-IMPLIED move spares anything already filed in a section; an
      // explicit one moves every task named.
      const movable =
        asked !== undefined ? owned : owned.filter((r) => r.canvasSectionId === null);
      // Keyed by board — but a BOARD-LESS task has only its project to say which
      // canvas it belongs on, so those group by project instead. Keying them all
      // under one `null` bucket would resolve the whole lot against whichever
      // project happened to come first.
      type Movable = (typeof owned)[number];
      const byBoard = new Map<
        string,
        { boardId: string | null; projectId: string | null; rows: Movable[] }
      >();
      for (const r of movable) {
        const key = r.boardId ?? `project:${r.projectId ?? ""}`;
        const bucket = byBoard.get(key);
        if (bucket) bucket.rows.push(r);
        else
          byBoard.set(key, {
            boardId: r.boardId,
            projectId: r.projectId,
            rows: [r],
          });
      }
      for (const [, { boardId, projectId, rows: group }] of byBoard) {
        const section = await resolvePlacementSection(target, boardId, projectId);
        // No group flagged for this placement — leave them where they are.
        // (`inbox` resolves to null legitimately, and unpinning IS the move.)
        if (section === null && target !== "inbox") continue;
        const stale = group.filter((r) => r.canvasSectionId !== section);
        if (!stale.length) continue;
        await db
          .update(tasks)
          .set({ canvasSectionId: section })
          .where(inArray(tasks.id, stale.map((r) => r.id)));
        for (const r of stale) {
          placed.set(r.id, target);
          repinned.set(r.id, section);
        }
      }
    }
  }

  // 4. One batched INSERT into the activity log — a trail row per task.
  const constMsg = describeBulkPatch(patch);
  const priorStatus = new Map(owned.map((r) => [r.id, r.status]));
  const priorAssignees = new Map(owned.map((r) => [r.id, r.assigneeIds]));
  // Resolved once, not per row — every row names the same actor.
  const assignNote = claimed ? await autoAssignNote(userId) : null;
  const ctx = currentLogContext();
  const logRows = rows.map((r) => {
    const parts: string[] = [];
    if (patch.status !== undefined && patch.status !== priorStatus.get(r.id))
      parts.push(
        `Status: ${STATUS_LABEL[priorStatus.get(r.id)!]} → ${STATUS_LABEL[patch.status]}`,
      );
    if (constMsg) parts.push(constMsg);
    const ref = relocked.get(r.id)?.ref;
    if (ref) parts.push(`🔒 Locked as ${ref}`);
    // Only the rows the claim actually added the actor to.
    if (
      assignNote &&
      r.assigneeIds.length > (priorAssignees.get(r.id)?.length ?? 0)
    )
      parts.push(assignNote);
    const to = placed.get(r.id);
    if (to !== undefined) parts.push(PLACEMENT_LOG[to]);
    return {
      taskId: r.id,
      kind: "updated" as const,
      message: parts.length ? parts.join(" · ") : "Updated",
      author,
      actorId: ctx?.actorId,
      source: ctx?.source,
    };
  });
  if (logRows.length) await db.insert(taskLogs).values(logRows);

  // 4b. One batched INSERT of status events, for the rows whose status actually
  //     moved. Same crediting rule as the single-task paths — it reads each
  //     row's OWN post-update assignees, which is why the per-row SQL merge in
  //     step 2 matters here: a bulk "move these to Building" credits each task
  //     to whoever is on it, not all of them to the caller.
  if (patch.status !== undefined) {
    const eventRows = rows
      .filter((r) => patch.status !== priorStatus.get(r.id))
      .flatMap((r) =>
        statusEventRows({
          taskId: r.id,
          from: priorStatus.get(r.id)!,
          to: patch.status!,
          assigneeIds: r.assigneeIds,
          at: now,
        }),
      );
    if (eventRows.length) await db.insert(taskStatusEvents).values(eventRows);
  }

  // 5. Shape the refreshed tasks (comment counts, like updateTask), preferring
  //     the post-lock row for anything 3b froze. `codes` is passed so soft codes
  //     resolve their prefix — without it every `code` came back undefined.
  const counts = await commentCounts(userId);
  return {
    updated: rows.length,
    skipped,
    blocked,
    tasks: rows.map((r) => {
      const row = relocked.get(r.id) ?? r;
      // 3c ran after both UPDATEs read their rows, so fold its pin back in.
      return rowToTask(
        repinned.has(r.id)
          ? { ...row, canvasSectionId: repinned.get(r.id)! }
          : row,
        counts.get(r.id) ?? 0,
        [],
        codes,
      );
    }),
  };
}

/**
 * Apply an ORDERED list of heterogeneous ops — the power tool for real
 * reorganization (create a roadmap, move some, complete a sprint, all in one
 * call). Each op is delegated to the matching single-task service function, so
 * ownership is enforced per-op and each leaves its own natural activity entry.
 * Best-effort (the Neon HTTP driver has no interactive transactions): a failing
 * op is captured as `{ ok:false, error }` and the batch continues, so partial
 * failure is always visible. Caps at MAX_BULK_OPS; extra ops are dropped and
 * reported via `truncated`.
 */
export async function bulkApply(
  userId: string,
  ops: BulkOp[],
  author = "You",
): Promise<{ results: OpResult[]; truncated: boolean; tasks: TaskDTO[] }> {
  const truncated = ops.length > MAX_BULK_OPS;
  const batch = truncated ? ops.slice(0, MAX_BULK_OPS) : ops;
  const results: OpResult[] = [];
  const touched = new Set<string>();

  for (const op of batch) {
    try {
      switch (op.op) {
        case "create": {
          const t = await createTask(op.input, userId, author);
          touched.add(t.id);
          results.push({ op: "create", ok: true, id: t.id });
          break;
        }
        case "update": {
          const t = await updateTask(op.id, op.patch, userId, author);
          if (t) touched.add(t.id);
          results.push(
            t
              ? { op: "update", ok: true, id: t.id }
              : { op: "update", ok: false, id: op.id, error: "Task not found" },
          );
          break;
        }
        case "move": {
          const t = await moveTask(op.id, op.target, userId, author);
          if (t) touched.add(t.id);
          results.push(
            t
              ? { op: "move", ok: true, id: t.id }
              : { op: "move", ok: false, id: op.id, error: "Task not found or invalid target" },
          );
          break;
        }
        case "complete": {
          const t = await completeTask(op.id, op.done ?? true, userId, author);
          if (t) touched.add(t.id);
          results.push(
            t
              ? { op: "complete", ok: true, id: t.id }
              : { op: "complete", ok: false, id: op.id, error: "Task not found" },
          );
          break;
        }
        case "comment": {
          const c = await addComment(op.id, op.message, userId, author);
          if (c) touched.add(op.id);
          results.push(
            c
              ? { op: "comment", ok: true, id: op.id }
              : { op: "comment", ok: false, id: op.id, error: "Task not found" },
          );
          break;
        }
        case "archive": {
          // Cascades to the subtree, and rejects a task that isn't done — so a
          // batch that archives must complete first (ops run in array order).
          const t = await archiveTask(op.id, op.archived ?? true, userId, author);
          if (t) touched.add(t.id);
          results.push(
            t
              ? { op: "archive", ok: true, id: t.id }
              : { op: "archive", ok: false, id: op.id, error: "Task not found" },
          );
          break;
        }
        case "delete": {
          const ok = await deleteTask(op.id, userId);
          touched.delete(op.id);
          results.push({
            op: "delete",
            ok,
            id: op.id,
            error: ok ? undefined : "Task not found",
          });
          break;
        }
      }
    } catch (e) {
      results.push({
        op: op.op,
        ok: false,
        id: "id" in op ? op.id : undefined,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Refreshed post-state of every task the batch touched (deletes excluded).
  const tasksOut = await tasksByIds(userId, [...touched]);
  return { results, truncated, tasks: tasksOut };
}

/* -------------------------------------------------------------------- */
/* Attachments                                                           */
/* -------------------------------------------------------------------- */

export interface AddAttachmentInput {
  filename: string;
  mimeType: string;
  size: number;
  url: string;
}

/** Best-effort blob deletion — never let a storage hiccup block the DB op. */
async function delBlobs(urls: string[]): Promise<void> {
  try {
    await del(urls, blobAuth());
  } catch (e) {
    console.error("[service] failed to delete blob(s)", e);
  }
}

/** Record an uploaded image on a task (bytes already stored in Blob). */
export async function addAttachment(
  taskId: string,
  input: AddAttachmentInput,
  userId: string,
  author = "You",
): Promise<Attachment | null> {
  if (!(await ownsTask(taskId, userId))) return null;
  const [row] = await db
    .insert(taskAttachments)
    .values({
      taskId,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
      url: input.url,
    })
    .returning();
  await log(taskId, "attached", `📎 Attached ${input.filename}`, author);
  await db
    .update(tasks)
    .set({ updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
  return rowToAttachment(row);
}

/** Metadata for one attachment, ownership-checked via its task. */
export async function getAttachmentById(
  attachmentId: string,
  userId: string,
): Promise<Attachment | null> {
  const row = (
    await db
      .select({ a: taskAttachments })
      .from(taskAttachments)
      .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
      .where(eq(taskAttachments.id, attachmentId))
      .limit(1)
  )[0];
  return row ? rowToAttachment(row.a) : null;
}

/** Remove an attachment: delete its blob, drop the row, log it. */
export async function deleteAttachment(
  attachmentId: string,
  userId: string,
  author = "You",
): Promise<boolean> {
  const row = (
    await db
      .select({ a: taskAttachments })
      .from(taskAttachments)
      .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
      .where(eq(taskAttachments.id, attachmentId))
      .limit(1)
  )[0];
  if (!row) return false;
  const { a } = row;
  await delBlobs([a.url]);
  await db.delete(taskAttachments).where(eq(taskAttachments.id, a.id));
  await log(a.taskId, "attached", `🗑 Removed ${a.filename}`, author);
  await db
    .update(tasks)
    .set({ updatedAt: new Date() })
    .where(eq(tasks.id, a.taskId));
  return true;
}


/* -------------------------------------------------------------------- */
/* Notes (standup material)                                              */
/* -------------------------------------------------------------------- */

export interface AddNoteInput {
  note: string;
  type?: NoteType | null;
  /** Free-form labels — e.g. a decision's area ("technical", "product"). */
  tags?: string[];
}

/** Add a note to a task — a decision (with optional "Why" in the body) or a
 *  standup-worthy callout. Raw material for the standup digest + Notes page. */
export async function addNote(
  handle: string,
  input: AddNoteInput,
  userId: string,
  author = "You",
): Promise<Note | null> {
  const taskId = await resolveTaskId(handle, userId);
  if (!taskId) return null;
  const ctx = currentLogContext();
  const [row] = await db
    .insert(taskNotes)
    .values({
      taskId,
      userId,
      note: input.note,
      type: input.type ?? null,
      tags: input.tags ?? [],
      author,
      actorId: ctx?.actorId,
    })
    .returning();
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  return rowToNote(row);
}

/** Add a note anchored to a canvas position — a sticky dropped on the team
 *  whiteboard. `taskHandle` optionally ALSO links it to a task: the two
 *  anchors aren't mutually exclusive (see the schema comment on `taskNotes`).
 *  Null if the canvas doesn't exist, or `taskHandle` is given but unresolvable. */
export async function addCanvasNote(
  canvasId: string,
  x: number,
  y: number,
  input: AddNoteInput,
  userId: string,
  author = "You",
  taskHandle?: string,
): Promise<Note | null> {
  if (!(await canvasExists(canvasId))) return null;
  let taskId: string | null = null;
  if (taskHandle) {
    taskId = await resolveTaskId(taskHandle, userId);
    if (!taskId) return null;
  }
  const ctx = currentLogContext();
  const [row] = await db
    .insert(taskNotes)
    .values({
      canvasId,
      taskId,
      x,
      y,
      userId,
      note: input.note,
      type: input.type ?? null,
      tags: input.tags ?? [],
      author,
      actorId: ctx?.actorId,
    })
    .returning();
  await db
    .update(canvases)
    .set({ updatedAt: new Date() })
    .where(eq(canvases.id, canvasId));
  return rowToNote(row);
}

export interface NoteFilter {
  taskId?: string;
  canvasId?: string;
  type?: NoteType;
  from?: string;
  to?: string;
  /** Include checked-off (resolved) notes. Defaults to false — the live Notes
   *  view and standup only want open items. */
  includeResolved?: boolean;
}

/** Query notes across the team — powers the Notes page, standup, and a
 *  canvas's stickies. Team-visible like tasks/canvases: nobody is fenced out
 *  of anyone else's notes. By default only OPEN (unresolved) notes are
 *  returned. `_userId` stays a parameter (unused for scoping) so callers don't
 *  need to change and a future per-user view has a place to hang. */
export async function listNotes(
  _userId: string,
  filter?: NoteFilter,
): Promise<Note[]> {
  const conds: (SQL | undefined)[] = [];
  if (filter?.taskId) {
    const taskId = await resolveTaskId(filter.taskId, _userId);
    if (!taskId) return [];
    conds.push(eq(taskNotes.taskId, taskId));
  }
  if (filter?.canvasId) conds.push(eq(taskNotes.canvasId, filter.canvasId));
  if (filter?.type) conds.push(eq(taskNotes.type, filter.type));
  conds.push(
    ...inWindow(taskNotes.createdAt, dateWindow(filter?.from, filter?.to)),
  );
  if (!filter?.includeResolved) conds.push(isNull(taskNotes.resolvedAt));
  const rows = await db
    .select()
    .from(taskNotes)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(taskNotes.createdAt));
  return rows.map(rowToNote);
}

/** Check off (or re-open) a note, or move it (a sticky drag). Team-visible —
 *  any signed-in user may resolve or move any note, matching tasks/canvases.
 *  Returns the updated note, or null if not found. */
export async function patchNote(
  noteId: string,
  patch: { resolved?: boolean; x?: number; y?: number },
): Promise<Note | null> {
  const [row] = await db
    .update(taskNotes)
    .set({
      ...(patch.resolved !== undefined
        ? { resolvedAt: patch.resolved ? new Date() : null }
        : {}),
      ...(patch.x !== undefined ? { x: patch.x } : {}),
      ...(patch.y !== undefined ? { y: patch.y } : {}),
      updatedAt: new Date(),
    })
    .where(eq(taskNotes.id, noteId))
    .returning();
  if (!row) return null;
  if (row.taskId) {
    await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, row.taskId));
  }
  if (row.canvasId) {
    await db
      .update(canvases)
      .set({ updatedAt: new Date() })
      .where(eq(canvases.id, row.canvasId));
  }
  return rowToNote(row);
}

/** Check off (or re-open) a note. Thin wrapper over `patchNote` — kept as its
 *  own export so the MCP tool name/behavior doesn't change. */
export async function resolveNote(
  noteId: string,
  resolved: boolean,
  _userId: string,
): Promise<Note | null> {
  return patchNote(noteId, { resolved });
}

/** Move a note — a sticky drag on the canvas. Thin wrapper over `patchNote`. */
export async function moveNote(
  noteId: string,
  x: number,
  y: number,
  _userId: string,
): Promise<Note | null> {
  return patchNote(noteId, { x, y });
}

/** Permanently remove a note (a sticky's "×", or a mis-added task note).
 *  Unlike resolving, there's no undo. Team-visible — any signed-in user may
 *  delete any note, matching tasks/canvases. */
export async function deleteNote(noteId: string): Promise<boolean> {
  const [row] = await db
    .delete(taskNotes)
    .where(eq(taskNotes.id, noteId))
    .returning({ taskId: taskNotes.taskId, canvasId: taskNotes.canvasId });
  if (!row) return false;
  if (row.taskId) {
    await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, row.taskId));
  }
  if (row.canvasId) {
    await db
      .update(canvases)
      .set({ updatedAt: new Date() })
      .where(eq(canvases.id, row.canvasId));
  }
  return true;
}

/* -------------------------------------------------------------------- */
/* Commits                                                               */
/* -------------------------------------------------------------------- */

/**
 * Link a git commit back to a task. Idempotent per (task, sha).
 */
export async function linkCommit(
  handle: string,
  sha: string,
  subject: string | null,
  userId: string,
): Promise<TaskCommit | null> {
  const taskId = await resolveTaskId(handle, userId);
  if (!taskId) return null;
  const task = (
    await db.select().from(tasks).where(eq(tasks.id, taskId))
  )[0];
  if (!task) return null;
  const [row] = await db
    .insert(taskCommits)
    .values({ taskId, userId, sha, subject })
    .onConflictDoNothing({ target: [taskCommits.taskId, taskCommits.sha] })
    .returning();

  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));

  // On a duplicate the insert returned nothing — fetch the existing row.
  if (!row) {
    const existing = (
      await db
        .select()
        .from(taskCommits)
        .where(and(eq(taskCommits.taskId, taskId), eq(taskCommits.sha, sha)))
        .limit(1)
    )[0];
    return existing ? rowToCommit(existing) : null;
  }
  return rowToCommit(row);
}

/* -------------------------------------------------------------------- */
/* Standup digest                                                        */
/* -------------------------------------------------------------------- */

/** One person's work on one task inside a window. Both lists are DERIVED from
 *  consecutive events, never stored — so they can't drift from the task's status. */
export interface WorkEntry {
  task: TaskDTO;
  /**
   * Time spent actively working, per stage — open-ended while still in it.
   * Only `analyzing`/`building`: sitting in `analyzed` or `review` is waiting
   * for the next person, and billing that as work time would be a lie.
   */
  stints: { status: TaskStatus; from: string; to: string | null; minutes: number | null }[];
  /** Every credited transition in the window, so a person whose whole
   *  contribution was "handed the analysis over" still has something to show. */
  moves: { to: TaskStatus; at: string }[];
}

/** A window's work, attributed per person. Every list is disjoint: a task lands
 *  in exactly one of them for a given viewer. */
export interface ActivityDigest {
  from: string;
  to: string;
  /** Whose digest this is — a user id, or "team" when unfiltered. */
  credited: string | "team";
  /** Reached done in the window, with a working stage credited to this person. */
  shipped: WorkEntry[];
  /** Their other credited transitions in the window (still in flight). */
  worked: WorkEntry[];
  /** Reached done credited to them with NO prior working stage — non-code work
   *  taken straight to Done. Rendered "handled", never "built". */
  handled: WorkEntry[];
  /** Reached done with nobody creditable. `closedBy` is who pressed the button:
   *  on the record, but not counted as their work. */
  closedUnattributed: { task: TaskDTO; closedBy: string | null }[];
  /** Set when the window predates the event log — attribution isn't knowable
   *  there, and saying so beats reconstructing it from prose. */
  attribution?: string;
}

/** Reaching any of these counts as having WORKED the task — including the
 *  handoff states, since "I analyzed it and handed it on" is work even though
 *  the person never touched `building`. */
const WORKED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "analyzing",
  "analyzed",
  "building",
  "review",
]);

/** …but only these are ACTIVE work, so only these produce a timed stint. A task
 *  parked in Review for three days says nothing about how long anyone worked. */
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "analyzing",
  "building",
]);

/**
 * Work in a window, attributed by `credited_to` — who the work belongs to, as
 * resolved at write time by `creditFor`. Pass `credited` for one person, omit it
 * for the whole team.
 *
 * Reads `task_status_events` (append-only) and derives each stint from the gap
 * to that task's next event, so nothing here can disagree with the task's real
 * status. Deliberately NOT built on `task_logs`: that's a human timeline, and
 * the facts a digest needs were never in it.
 */
export async function activityDigest(
  userId: string,
  // `credited` is REQUIRED and explicit: a user id for one person, `null` for
  // the whole team. It was optional once, and the one caller that omitted it got
  // an unfiltered team digest labelled "me" — every other person's work
  // presented as yours. An ambiguous default here is worse than a verbose call.
  opts: { from: string; to: string; credited: string | null; tz?: string },
): Promise<ActivityDigest> {
  const w = dateWindow(opts.from, opts.to, opts.tz);
  const conds: (SQL | undefined)[] = [
    ...effectiveWindow(w, opts.tz ?? APP_TIMEZONE),
  ];
  // One person's digest = their credited work, PLUS anything they closed that
  // nobody can be credited for. You should see the stale tasks you cleared —
  // they're just listed as cleared rather than counted as work.
  if (opts.credited)
    conds.push(
      or(
        eq(taskStatusEvents.creditedTo, opts.credited),
        and(
          isNull(taskStatusEvents.creditedTo),
          eq(taskStatusEvents.actorId, opts.credited),
        ),
      ),
    );

  // Events in the window, plus — for stint ends — each one's successor on the
  // same task, and — for "did they ever work it" — every event on those tasks.
  const inWindowRows = await db
    .select()
    .from(taskStatusEvents)
    .where(and(...conds))
    .orderBy(asc(taskStatusEvents.at));

  const taskIds = [...new Set(inWindowRows.map((r) => r.taskId))];
  if (!taskIds.length)
    return {
      from: opts.from,
      to: opts.to,
      credited: opts.credited ?? "team",
      shipped: [],
      worked: [],
      handled: [],
      closedUnattributed: [],
      ...(await attributionCaveat(w)),
    };

  const [allRows, tasksById] = await Promise.all([
    db
      .select()
      .from(taskStatusEvents)
      .where(inArray(taskStatusEvents.taskId, taskIds))
      .orderBy(asc(taskStatusEvents.at)),
    tasksByIds(userId, taskIds).then(
      (ts) => new Map(ts.map((t) => [t.id, t])),
    ),
  ]);

  /** taskId → its events in order, for deriving stint ends. */
  const timeline = new Map<string, TaskStatusEventRow[]>();
  for (const r of allRows) {
    const list = timeline.get(r.taskId);
    if (list) list.push(r);
    else timeline.set(r.taskId, [r]);
  }
  /** When did this event's stage end? The next event on the task, or open. */
  const endOf = (r: TaskStatusEventRow): Date | null => {
    const list = timeline.get(r.taskId) ?? [];
    const next = list.find((o) => o.at > r.at);
    return next ? next.at : null;
  };

  const shipped: WorkEntry[] = [];
  const worked: WorkEntry[] = [];
  const handled: WorkEntry[] = [];
  const closedUnattributed: ActivityDigest["closedUnattributed"] = [];

  // Group the window's events by (credited person, task) so one task yields one
  // entry per person, carrying all of their stints on it.
  const byPerson = new Map<string, TaskStatusEventRow[]>();
  for (const r of inWindowRows) {
    const key = `${r.creditedTo ?? ""} ${r.taskId}`;
    const list = byPerson.get(key);
    if (list) list.push(r);
    else byPerson.set(key, [r]);
  }

  for (const [key, events] of byPerson) {
    const [credited, taskId] = key.split(" ");
    const task = tasksById.get(taskId);
    if (!task) continue; // deleted, or outside this viewer's reach

    const closedHere = events.some((e) => e.toStatus === "done");

    if (!credited) {
      // Nobody creditable. Only surface the close itself — an unattributable
      // "moved to review" is noise, but an unattributable ship is a fact.
      if (closedHere)
        closedUnattributed.push({
          task,
          closedBy: events.find((e) => e.toStatus === "done")?.actorId ?? null,
        });
      continue;
    }

    const stints = events
      .filter((e) => ACTIVE_STATUSES.has(e.toStatus))
      .map((e) => {
        const end = endOf(e);
        return {
          status: e.toStatus,
          from: iso(e.at)!,
          to: iso(end) ?? null,
          minutes: end
            ? Math.round((end.getTime() - e.at.getTime()) / 60_000)
            : null,
        };
      });
    const moves = events.map((e) => ({ to: e.toStatus, at: iso(e.at)! }));
    const workedHere = events.some((e) => WORKED_STATUSES.has(e.toStatus));

    const entry: WorkEntry = { task, stints, moves };

    if (closedHere) {
      // Did this person ever work a stage on it — in this window or before? If
      // so it's theirs; if not, they took it straight to done (non-code work).
      const everWorked = (timeline.get(taskId) ?? []).some(
        (e) => e.creditedTo === credited && WORKED_STATUSES.has(e.toStatus),
      );
      (everWorked ? shipped : handled).push(entry);
    } else if (workedHere) {
      worked.push(entry);
    }
  }

  return {
    from: opts.from,
    to: opts.to,
    credited: opts.credited ?? "team",
    shipped,
    worked,
    handled,
    closedUnattributed,
    ...(await attributionCaveat(w)),
  };
}

/** Warn when a window starts before the event log did, so an empty or thin
 *  digest reads as "not recorded yet" instead of "you did nothing". */
async function attributionCaveat(w: {
  start?: Date;
  end?: Date;
}): Promise<{ attribution?: string }> {
  if (!w.start) return {};
  const [first] = await db
    .select({ at: taskStatusEvents.at })
    .from(taskStatusEvents)
    .orderBy(asc(taskStatusEvents.at))
    .limit(1);
  if (!first || first.at <= w.start) return {};
  return {
    attribution: `unavailable-before-${iso(first.at)} — attribution wasn't recorded before then, so anything earlier is missing rather than empty`,
  };
}

/* ---- Completions (the Done view) ---------------------------------------
   The Done view's unit is a done EVENT, not a task: the same task appears once
   per credited person, and again on any later day it was re-done. That's why
   this doesn't go through `taskWhere` / `TaskFilter`, whose unit is a task. */

/** One task reaching `done`, credited to one person, on one day — the Done
 *  view's row. */
export interface Completion {
  task: TaskDTO;
  /** When it reached done — the LATEST such event within `day`. */
  at: string;
  /** The day `at` falls on in the requested tz. Computed here so the client's
   *  week/day buckets tile exactly the way the window edges do. */
  day: string;
  /** Whose WORK it was (`credited_to`). Null = nobody creditable, which for a
   *  `done` transition means the task had no assignees (WORK_STATUSES excludes
   *  done, so `creditFor` can't fall back to the actor). The view's "no
   *  assignee" column — honest, not a gap. */
  creditedTo: string | null;
  /** Who pressed the button. On the record for the unattributed column only;
   *  never treat it as credit — that conflation is what TD-54 removed. */
  closedBy: string | null;
}

/** One chunk of the Done log. The client asks for four weeks at a time and walks
 *  `from` backwards; `dateWindow` is half-open, so chunks tile with no
 *  double-counted or skipped day at the seam. */
export interface CompletionsPage {
  from: string;
  to: string;
  tz: string;
  /** Newest first. */
  entries: Completion[];
  /** Set when the cap truncated the window, so a partial chunk says so rather
   *  than passing for a complete one. */
  truncated?: boolean;
  /** Set when the window predates the event log — same caveat the digest gives. */
  attribution?: string;
  /**
   * The standup each person wrote for each day in the window — the header of the
   * very column these entries fill.
   *
   * Rides along rather than getting its own route: same project, same window,
   * same reader, and two text columns don't earn a second round trip. Only
   * populated for a project-scoped read, since a work day is keyed by project.
   */
  writeUps?: DayWriteUp[];
}

/** Cap on one chunk — a guardrail, not a page size (four weeks of one project's
 *  completions is tens of rows). Fetched as `limit + 1` so `truncated` is
 *  observed rather than guessed. */
const COMPLETIONS_LIMIT = 2000;

/** One done event, reduced to what the crediting rule needs. */
export interface DoneEvent {
  taskId: string;
  creditedTo: string | null;
  at: Date;
  /**
   * The working day this transition is credited to, overriding the one derived
   * from `at`. Null/absent for almost every row — set only where the recording
   * time and the working day genuinely differ: work logged after the fact (a
   * phone call written up the next morning) and the Done view's re-dating.
   *
   * `at` stays the immutable record of when we learned; this is which day the
   * work belongs to. Keeping them as two facts is what lets a late correction
   * fix a standup without rewriting history.
   */
  workedOn?: string | null;
}

/** Which working day an event counts for: its explicit override, else the day
 *  its recording instant falls on. The one rule, so no reader re-derives it. */
export const effectiveDay = (e: DoneEvent, tz: string): string =>
  e.workedOn ?? workingDayOf(e.at, tz);

/**
 * WHICH done events become rows in the Done view — the whole rule, in one pure
 * function so it can be checked without a database (`npm run check:done`).
 *
 * Input must be sorted newest-first (the query's own order). Output keeps that
 * order and is one row per (task, credited person, day):
 *
 *  • **Per day, not per task.** Two completions of the same task 20 minutes
 *    apart are one row; three weeks apart, two rows — which is the truth, and
 *    the day is the view's finest bucket so nothing visible is lost either way.
 *    Keeping only a task's LATEST completion instead would rewrite history and
 *    break paging: re-doning an old task would silently delete it from a chunk
 *    the client already holds.
 *  • **Latest within the day**, so a day's column reads most-recently-finished
 *    first and the timestamp shown is the last time it was confirmed done.
 *  • **Per credited person.** `creditFor` emits one event per assignee, so a
 *    two-assignee task yields two rows and its card lands in both columns.
 *  • **Credited beats uncredited on the same day.** Closed twice in a day, once
 *    with an assignee and once without, the card belongs in that person's column
 *    — not in theirs AND in "no assignee".
 */
export function pickCompletions<T extends DoneEvent>(
  newestFirst: T[],
  tz: string,
): (T & { day: string })[] {
  const byKey = new Map<string, T & { day: string }>();
  for (const e of newestFirst) {
    const day = effectiveDay(e, tz);
    const key = `${e.taskId} ${e.creditedTo ?? ""} ${day}`;
    // Newest-first input ⇒ the first row seen for a key is the latest one.
    if (!byKey.has(key)) byKey.set(key, { ...e, day });
  }
  const credited = new Set(
    [...byKey.values()]
      .filter((c) => c.creditedTo)
      .map((c) => `${c.taskId} ${c.day}`),
  );
  return [...byKey.values()].filter(
    (c) => c.creditedTo || !credited.has(`${c.taskId} ${c.day}`),
  );
}

/**
 * Everything that reached `done` in a window, one entry per (task, credited
 * person, day) — the Done view's read.
 *
 * Reads `task_status_events`, NOT `tasks.completedAt`: that column holds only
 * the latest completion, is overwritten on re-done and CLEARED on reopen, and
 * carries no crediting, so it cannot answer "who finished what, when".
 *
 * Two predicates are deliberately ABSENT:
 *   • no archived filter — a task swept off the board still shipped;
 *   • no `tasks.status = 'done'` — a reopened task was still finished that day,
 *     and without this, past weeks would silently rewrite themselves whenever
 *     someone reopens something.
 */
export async function listCompletions(
  userId: string,
  opts: {
    from: string;
    to: string;
    projectId?: string;
    boardId?: string;
    creditedTo?: string;
    tz?: string;
    limit?: number;
  },
): Promise<CompletionsPage> {
  const tz = opts.tz ?? APP_TIMEZONE;
  const limit = opts.limit ?? COMPLETIONS_LIMIT;
  const w = dateWindow(opts.from, opts.to, tz);

  const rows = await db
    .select({
      at: taskStatusEvents.at,
      workedOn: taskStatusEvents.workedOn,
      creditedTo: taskStatusEvents.creditedTo,
      actorId: taskStatusEvents.actorId,
      // List columns only (PLAT-403); nested so nothing collides with the event
      // columns above, and so `rowToTask` gets a ListTaskRow as-is.
      task: LIST_TASK_COLUMNS,
    })
    .from(taskStatusEvents)
    .innerJoin(tasks, eq(tasks.id, taskStatusEvents.taskId))
    .where(
      and(
        eq(taskStatusEvents.toStatus, "done"),
        ...effectiveWindow(w, tz),
        // Archived work still shipped (see above) — deleted work is in the Trash,
        // which is off every surface until it's restored.
        isNull(tasks.deletedAt),
        // A board-less task in a project still carries `projectId`, so this is
        // the right column rather than a join through boards.
        opts.projectId ? eq(tasks.projectId, opts.projectId) : undefined,
        opts.boardId ? eq(tasks.boardId, opts.boardId) : undefined,
        opts.creditedTo
          ? eq(taskStatusEvents.creditedTo, opts.creditedTo)
          : undefined,
      ),
    )
    // Newest first; `tasks.id` breaks ties so the cap keeps a stable slice.
    .orderBy(desc(taskStatusEvents.at), asc(tasks.id))
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;

  const { fromDay, toDay } = dayBounds(w, tz);
  const [counts, ctx, writeUps] = await Promise.all([
    commentCounts(userId),
    codeCtx(userId),
    // A work day is keyed by (person, project, day), so this answers only for a
    // project-scoped read. A `boardId` read gets none: the prose covers a whole
    // day across the project, and hanging it off one board's slice of that day
    // would overstate what it says.
    opts.projectId && !opts.boardId && fromDay && toDay
      ? listDayWriteUps({
          projectId: opts.projectId,
          fromDay,
          toDay,
          ...(opts.creditedTo ? { userId: opts.creditedTo } : {}),
        })
      : Promise.resolve<DayWriteUp[]>([]),
  ]);

  // The rule itself is pure and lives in `pickCompletions`; all this does is
  // hand it the events and hydrate whatever survives.
  const rowById = new Map(kept.map((r) => [r.task.id, r.task]));
  const picked = pickCompletions(
    kept.map((r) => ({
      taskId: r.task.id,
      creditedTo: r.creditedTo,
      at: r.at,
      workedOn: r.workedOn,
      closedBy: r.actorId,
    })),
    tz,
  );

  return {
    from: opts.from,
    to: opts.to,
    tz,
    entries: picked.map((p) => {
      const row = rowById.get(p.taskId)!;
      return {
        task: rowToTask(row, counts.get(p.taskId) ?? 0, undefined, ctx),
        at: iso(p.at)!,
        day: p.day,
        creditedTo: p.creditedTo,
        closedBy: p.closedBy,
      };
    }),
    ...(truncated ? { truncated } : {}),
    ...(writeUps.length ? { writeUps } : {}),
    ...(await attributionCaveat(w)),
  };
}

/* ---- Work days -----------------------------------------------------------
   One person's working day on one project. See the `workDays` table comment for
   why this holds two artifacts and no task list.

   Nothing here opens a day: `getWorkDay` answers for any date whether or not a
   row exists, because a day exists by virtue of work happening in it. A missing
   row means "neither artifact was produced", never "no such day". */

/** One line of the morning snapshot — enough to show the list back without
 *  joining to `tasks`, so it still reads correctly after a task is renamed or
 *  deleted. That's the point of a snapshot. */
export interface WorkDaySnapshotEntry {
  taskId: string;
  /** The display code as it stood (`TD-65`), when it had one. */
  ref?: string;
  title: string;
  status: TaskStatus;
}

/** A work day, with `sealed` derived. */
export interface WorkDay {
  userId: string;
  projectId: string;
  day: string;
  readyAt: string | null;
  snapshot: WorkDaySnapshotEntry[] | null;
  draftedAt: string | null;
  bullets: string | null;
  summary: string | null;
  /**
   * Frozen: a LATER day for this person and project has been drafted.
   *
   * Derived rather than stored, which is what gives the standup the window it
   * needs — yesterday stays correctable while you're presenting it, and shuts by
   * itself the moment you draft today. Nothing to press, nothing to fall out of
   * sync.
   */
  sealed: boolean;
}

/** What the close-out needs to show, in one read. */
export interface WorkDayReview {
  day: WorkDay;
  /** Everything credited to this person on this day. */
  digest: ActivityDigest;
  /** Notes written on the day — the standup's Progress/Blockers material. */
  notes: Note[];
  /**
   * Probably-finished work: tasks sitting in a late work status that the person
   * actually touched that day. The close-out's "which of these finished?" list.
   * Proposals only — each still goes through its own confirmation.
   */
  candidates: TaskDTO[];
  /**
   * Earlier working days with this person's work on them that were never
   * drafted, newest first — the debt the close-out collects. Empty is the normal,
   * happy case.
   */
  openDays: string[];
  /** Snapshot vs reality. Absent when no snapshot was taken. */
  drift?: {
    /** On the morning list, never completed. */
    plannedNotDone: WorkDaySnapshotEntry[];
    /** Completed but not on the morning list — the day's real interruptions. */
    doneNotPlanned: TaskDTO[];
  };
}

/** Statuses that mean "in flight, plausibly finished today". */
const CANDIDATE_STATUSES: TaskStatus[] = ["building", "review", "analyzed"];

/**
 * A stored snapshot, or null if the column holds anything else.
 *
 * `jsonb` is untyped at the boundary, so a cast would let a malformed row through
 * to the view and crash the render. Same defensive posture as `clampImportance`:
 * coerce at the read, so a bad row degrades to "no snapshot taken" — which is a
 * state the close-out already handles — rather than taking the screen down.
 */
function parseSnapshot(value: unknown): WorkDaySnapshotEntry[] | null {
  if (!Array.isArray(value)) return null;
  const ok = value.every(
    (e): e is WorkDaySnapshotEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as WorkDaySnapshotEntry).taskId === "string" &&
      typeof (e as WorkDaySnapshotEntry).title === "string" &&
      typeof (e as WorkDaySnapshotEntry).status === "string",
  );
  return ok ? (value as WorkDaySnapshotEntry[]) : null;
}

const rowToWorkDay = (r: WorkDayRow, sealed: boolean): WorkDay => ({
  userId: r.userId,
  projectId: r.projectId,
  day: r.day,
  readyAt: iso(r.readyAt) ?? null,
  snapshot: parseSnapshot(r.snapshot),
  draftedAt: iso(r.draftedAt) ?? null,
  bullets: r.bullets,
  summary: r.summary,
  sealed,
});

/**
 * That a person wrote a standup for a day, and roughly what it said.
 *
 * Deliberately not a `WorkDay`, and deliberately carries no prose. `snapshot` is
 * a jsonb per person per day that no header shows; `summary` and `bullets` are
 * unbounded authored text, and a Done-view read spans four weeks × the whole team
 * and grows from there — exactly the shape `LIST_TASK_COLUMNS` exists to refuse
 * (PLAT-403). What a column head actually needs is one line, so one line is what
 * crosses the wire; `GET /api/work-days/write-up` fetches the full text for the
 * one column someone opens. `sealed` is dropped too — a per-row extra query, and
 * the same route answers it when it matters.
 */
export interface DayWriteUp {
  userId: string;
  /** The working day, `YYYY-MM-DD`. */
  day: string;
  /** When Finish work ran. Never null here — an undrafted day has no prose. */
  draftedAt: string;
  /** One plain-text line of it — see `previewOf`. Never empty: a row with nothing
   *  written in it isn't returned at all. */
  preview: string;
  /** There is more than the preview shows, so opening it is worth a fetch. */
  hasMore: boolean;
}

/**
 * Every write-up a team produced on one project over a range of working days.
 *
 * The team's, not one person's: this feeds the Done view, where a day is read as
 * a column per person, so the whole day arrives in one query rather than one per
 * column. Rows with neither artifact are dropped — an empty header is worse than
 * no header, because it reads as a standup that said nothing.
 */
export async function listDayWriteUps(opts: {
  projectId: string;
  /** Inclusive working-day bounds — see `dayBounds`. */
  fromDay: string;
  toDay: string;
  /** Narrow to one person, for a read that was already narrowed to them. */
  userId?: string;
}): Promise<DayWriteUp[]> {
  const rows = await db
    .select({
      userId: workDays.userId,
      day: workDays.day,
      draftedAt: workDays.draftedAt,
      bullets: workDays.bullets,
      summary: workDays.summary,
    })
    .from(workDays)
    .where(
      and(
        eq(workDays.projectId, opts.projectId),
        // Drafted only: a row that exists for its morning snapshot alone has
        // nothing to say yet.
        isNotNull(workDays.draftedAt),
        sql`${workDays.day} >= ${opts.fromDay}`,
        sql`${workDays.day} <= ${opts.toDay}`,
        opts.userId ? eq(workDays.userId, opts.userId) : undefined,
      ),
    );
  return rows
    .filter((r) => r.summary?.trim() || r.bullets?.trim())
    .map((r) => {
      /* The prose is SELECTed — a preview has to be derived from something — but
         it stops here and never reaches a caller. Preview the summary when there
         is one, else the bullets, which is the same order the header falls back
         in. */
      const { preview, truncated } = previewOf(r.summary ?? r.bullets);
      return {
        userId: r.userId,
        day: r.day,
        draftedAt: iso(r.draftedAt)!,
        preview,
        // Either the teaser was cut, or there's a second field it didn't cover.
        hasMore:
          truncated || Boolean(r.summary?.trim() && r.bullets?.trim()),
      };
    });
}

/** Has a later day for this person+project been drafted? The whole of the
 *  sealing rule. */
async function isSealed(
  userId: string,
  projectId: string,
  day: string,
): Promise<boolean> {
  const [later] = await db
    .select({ day: workDays.day })
    .from(workDays)
    .where(
      and(
        eq(workDays.userId, userId),
        eq(workDays.projectId, projectId),
        isNotNull(workDays.draftedAt),
        sql`${workDays.day} > ${day}`,
      ),
    )
    .limit(1);
  return Boolean(later);
}

/** A day's row, or an empty day — never null, because the day exists either way. */
export async function getWorkDay(
  userId: string,
  projectId: string,
  day: string,
): Promise<WorkDay> {
  const [row, sealed] = await Promise.all([
    db
      .select()
      .from(workDays)
      .where(
        and(
          eq(workDays.userId, userId),
          eq(workDays.projectId, projectId),
          eq(workDays.day, day),
        ),
      )
      .limit(1)
      .then((rs) => rs[0]),
    isSealed(userId, projectId, day),
  ]);
  return row
    ? rowToWorkDay(row, sealed)
    : {
        userId,
        projectId,
        day,
        readyAt: null,
        snapshot: null,
        draftedAt: null,
        bullets: null,
        summary: null,
        sealed,
      };
}

/** Upsert one day's row, touching only the columns given. */
async function upsertWorkDay(
  userId: string,
  projectId: string,
  day: string,
  patch: Partial<Pick<NewWorkDayRow, "readyAt" | "snapshot" | "draftedAt" | "bullets" | "summary">>,
): Promise<WorkDay> {
  await db
    .insert(workDays)
    .values({ userId, projectId, day, ...patch })
    .onConflictDoUpdate({
      target: [workDays.userId, workDays.projectId, workDays.day],
      set: { ...patch, updatedAt: new Date() },
    });
  return getWorkDay(userId, projectId, day);
}

/** The tasks currently filed in a placement bucket for one project, resolved the
 *  same way the canvas resolves them (own pin, else inherited from the parent,
 *  else INBOX). */
async function tasksInPlacement(
  userId: string,
  projectId: string,
  bucket: TaskPlacement,
): Promise<TaskDTO[]> {
  const [all, map] = await Promise.all([
    listTasksFlat(userId, { projectId, includeDone: false }),
    listPlacementSections(projectId),
  ]);
  const byId = new Map(all.map((t) => [t.id, t]));
  const taskMap: Record<string, Task> = Object.fromEntries(
    all.map((t) => [t.id, t as Task]),
  );
  const parentOf = (id: string) => byId.get(id)?.parentId ?? null;
  return all.filter(
    (t) => placementOfTask(t.id, taskMap, parentOf, map) === bucket,
  );
}

/**
 * "Ready for the day" — freeze the todo as it stands.
 *
 * Re-pressing overwrites, deliberately: this records the list you committed to,
 * and if you rearrange and press again, the later arrangement is the real
 * commitment. Nothing about crediting changes — a snapshot is a record, not a
 * boundary, which is why pressing it (or not) can't affect where work lands.
 */
export async function markDayReady(
  userId: string,
  projectId: string,
  day: string,
): Promise<WorkDay> {
  // A snapshot is of the list AS IT STANDS, so it can only honestly be taken for
  // the day you're in. Allowing a past day would record today's TODAY as that
  // morning's plan — a fiction, stored as a fact, and the drift figures computed
  // from it would be nonsense.
  const current = currentWorkingDay();
  if (day !== current)
    throw new ValidationError(
      `A snapshot records the list as it stands now, so it can only be taken for the current working day (${current}), not ${day}.`,
    );
  const today = await tasksInPlacement(userId, projectId, "today");
  const snapshot: WorkDaySnapshotEntry[] = today.map((t) => ({
    taskId: t.id,
    ...(t.code ? { ref: t.code } : {}),
    title: t.title,
    status: t.status,
  }));
  return upsertWorkDay(userId, projectId, day, {
    readyAt: new Date(),
    snapshot,
  });
}

/**
 * "Finish work" — the day is drafted and ready to present.
 *
 * Records only the two authored fields. It does NOT complete anything: each task
 * goes through its own confirmation (`completeTask`), so the close-out batches
 * the asking, never the deciding.
 */
export async function finishWork(
  userId: string,
  projectId: string,
  day: string,
  input: { bullets?: string | null; summary?: string | null },
): Promise<WorkDay> {
  // A future day would seal every real day behind it (sealing is "a later day is
  // drafted") and there is no unseal, so this would be unrecoverable. Checked
  // before `sealed` so the message names the actual mistake.
  const today = currentWorkingDay();
  if (day > today)
    throw new ValidationError(
      `${day} hasn't happened yet — the current working day is ${today}. Drafting a future day would seal every day before it.`,
    );
  const current = await getWorkDay(userId, projectId, day);
  if (current.sealed)
    throw new ValidationError(
      `Working day ${day} is sealed — a later day has already been drafted. Late work is credited to the current day instead.`,
    );
  return upsertWorkDay(userId, projectId, day, {
    draftedAt: new Date(),
    ...(input.bullets !== undefined ? { bullets: input.bullets } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  });
}

/** How far back `listOpenDays` looks. Two weeks covers a holiday; beyond that an
 *  unclosed day is history rather than a debt worth chasing. */
const OPEN_DAYS_LOOKBACK = 14;

/**
 * Working days that have this person's work on them but were never drafted —
 * newest first.
 *
 * This is what makes the close-out find YOU. Without it, a day you forgot is
 * invisible unless you happen to navigate to its date, which is exactly the
 * failure the work-day design set out to prevent: the record quietly diverges and
 * nothing ever says so.
 *
 * The current working day is excluded — it's in progress, not neglected.
 *
 * Grouped in JS through `effectiveDay` rather than with SQL date arithmetic. The
 * range scan is indexed (`task_status_events_credited_at_idx`) and a fortnight of
 * one person's events is a small set, so the win of expressing it in SQL is
 * nothing next to having the working-day rule live in exactly one place. A
 * `coalesce(worked_on, …)` here would be a second implementation of it, free to
 * disagree with the first.
 */
export async function listOpenDays(
  userId: string,
  projectId: string,
  opts?: { lookbackDays?: number; tz?: string },
): Promise<string[]> {
  const tz = opts?.tz ?? APP_TIMEZONE;
  const today = currentWorkingDay(tz);
  const from = workingDayStart(today, tz, -(opts?.lookbackDays ?? OPEN_DAYS_LOOKBACK));

  const [events, drafted] = await Promise.all([
    db
      .select({ at: taskStatusEvents.at, workedOn: taskStatusEvents.workedOn })
      .from(taskStatusEvents)
      .innerJoin(tasks, eq(tasks.id, taskStatusEvents.taskId))
      .where(
        and(
          eq(taskStatusEvents.creditedTo, userId),
          eq(tasks.projectId, projectId),
          isNull(tasks.deletedAt),
          sql`${taskStatusEvents.at} >= ${from}`,
        ),
      ),
    db
      .select({ day: workDays.day })
      .from(workDays)
      .where(
        and(
          eq(workDays.userId, userId),
          eq(workDays.projectId, projectId),
          isNotNull(workDays.draftedAt),
        ),
      ),
  ]);

  const closed = new Set(drafted.map((r) => r.day));
  const open = new Set<string>();
  for (const e of events) {
    // `effectiveDay` takes the same shape a completion does; only the two date
    // fields matter here.
    const day = effectiveDay({ taskId: "", creditedTo: userId, ...e }, tz);
    if (day !== today && day >= workingDayOf(from, tz) && !closed.has(day))
      open.add(day);
  }
  return [...open].sort().reverse();
}

/** Everything the close-out shows, in one read. */
export async function workDayReview(
  userId: string,
  projectId: string,
  day: string,
  tz = APP_TIMEZONE,
): Promise<WorkDayReview> {
  const [dayRow, digest, notes, inFlight, openDays] = await Promise.all([
    getWorkDay(userId, projectId, day),
    activityDigest(userId, { from: day, to: day, credited: userId, tz }),
    listNotes(userId, { from: day, to: day }),
    listTasksFlat(userId, {
      projectId,
      status: CANDIDATE_STATUSES,
      includeDone: false,
    }),
    listOpenDays(userId, projectId, { tz }),
  ]);

  // "Touched that day" comes from the digest rather than a second query: it
  // already resolved who the work belongs to, which a status filter cannot.
  const touched = new Set(
    [...digest.worked, ...digest.shipped, ...digest.handled].map(
      (e) => e.task.id,
    ),
  );
  const candidates = inFlight.filter((t) => touched.has(t.id));

  const closed = [...digest.shipped, ...digest.handled].map((e) => e.task);
  const drift = dayRow.snapshot
    ? {
        plannedNotDone: dayRow.snapshot.filter(
          (s) => !closed.some((t) => t.id === s.taskId),
        ),
        doneNotPlanned: closed.filter(
          (t) => !dayRow.snapshot!.some((s) => s.taskId === t.id),
        ),
      }
    : undefined;

  return {
    day: dayRow,
    digest,
    notes,
    candidates,
    // A day being reviewed isn't its own debt, however it was reached.
    openDays: openDays.filter((d) => d !== day),
    ...(drift ? { drift } : {}),
  };
}

/**
 * Log work that never reached the board — a phone call, a conversation, an
 * errand. Creates a real task, already done, credited to the day it happened.
 *
 * A real task rather than a separate day-log entry, so there is ONE record of
 * what you did: searchable a year later, and consistent with the board being the
 * record rather than a partial view of it. Filed straight into DONE THIS WEEK so
 * it never sits in a triage lane asking to be worked.
 *
 * `withWorkedOn` is what puts it on the right day: the create-and-complete
 * happens now, but every status event it writes is credited to `day`.
 */
export async function logPastWork(
  userId: string,
  input: {
    title: string;
    day: string;
    boardId?: string | null;
    description?: string;
    author?: string;
  },
): Promise<TaskDTO> {
  return withWorkedOn(input.day, () =>
    createTask(
      {
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.boardId ? { boardId: input.boardId } : {}),
        status: "done",
        placement: "doneThisWeek",
        assigneeIds: [userId],
      },
      userId,
      input.author ?? "You",
    ),
  );
}

/* `standup()` is gone: it wrapped `activityDigest` in a flat `finished` list,
   which is the very conflation this task removed — a task you shipped and one
   someone else closed off the board are different facts and now have different
   homes. Callers (the MCP tool, the standup prompt, /api/standup) read the
   digest directly and pair it with `listNotes`. */

/* -------------------------------------------------------------------- */
/* Projects & Boards                                                     */
/* -------------------------------------------------------------------- */

const rowToBoard = (r: BoardRow): Board => ({
  id: r.id,
  projectId: r.projectId,
  name: r.name,
  code: r.code,
  color: r.color,
  image: r.image,
  gitFolder: r.gitFolder,
  description: r.description,
});

/** Map a project row to its DTO scalars (boards attached separately). */
const rowToProject = (r: ProjectRow): Omit<Project, "boards"> => ({
  id: r.id,
  name: r.name,
  code: r.code,
  color: r.color,
  image: r.image,
  gitFolder: r.gitFolder,
  description: r.description,
});

/** True if the project exists (team-wide — anyone may edit any project). */
async function ownsProject(id: string, _userId?: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)
  )[0];
  return !!row;
}

/** One board by id (team-wide; null if it doesn't exist). */
export async function getBoard(
  _userId: string,
  id: string,
): Promise<Board | null> {
  const row = (
    await db
      .select()
      .from(boards)
      .where(eq(boards.id, id))
      .limit(1)
  )[0];
  return row ? rowToBoard(row) : null;
}

/** True if the board exists (team-wide — anyone may edit any board). */
async function ownsBoard(id: string, _userId?: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: boards.id })
      .from(boards)
      .where(eq(boards.id, id))
      .limit(1)
  )[0];
  return !!row;
}

/** Next sort position at the end of a group (projects, or boards in a project). */
async function nextOrdinal(
  table: typeof projects | typeof boards,
  where: SQL | undefined,
): Promise<number> {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${table.position}), 0)` })
    .from(table)
    .where(where);
  return Number(max) + 1;
}

/** Every project on the instance, each with its boards nested (position order).
 *  Team-wide: projects/boards are shared, so `userId` is ignored. */
export async function listProjects(_userId: string): Promise<Project[]> {
  const [projectRows, boardRows, memberRows] = await Promise.all([
    db.select().from(projects).orderBy(asc(projects.position)),
    db.select().from(boards).orderBy(asc(boards.position)),
    // Every project's members (curation layer for the assignee picker).
    db
      .select({
        projectId: projectMembers.projectId,
        userId: projectMembers.userId,
      })
      .from(projectMembers),
  ]);
  const byProject = new Map<string, Board[]>();
  for (const b of boardRows) {
    const list = byProject.get(b.projectId) ?? [];
    list.push(rowToBoard(b));
    byProject.set(b.projectId, list);
  }
  const membersByProject = new Map<string, string[]>();
  for (const m of memberRows) {
    const list = membersByProject.get(m.projectId) ?? [];
    list.push(m.userId);
    membersByProject.set(m.projectId, list);
  }
  return projectRows.map((p: ProjectRow) => ({
    ...rowToProject(p),
    boards: byProject.get(p.id) ?? [],
    members: membersByProject.get(p.id) ?? [],
  }));
}

/** One project by id, scoped to the user (null if not found / not theirs). */
export async function getProject(
  userId: string,
  id: string,
): Promise<Omit<Project, "boards"> | null> {
  const row = (
    await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)
  )[0];
  return row ? rowToProject(row) : null;
}

export async function createProject(
  userId: string,
  name: string,
  opts: {
    code?: string;
    color?: string;
    image?: string | null;
    gitFolder?: string | null;
    description?: string | null;
    /** Roster user ids to seed as members (exactly these; none ⇒ no members). */
    members?: string[];
  } = {},
): Promise<Project> {
  const position = await nextOrdinal(projects, undefined);
  const code =
    opts.code !== undefined
      ? await uniqueFrom(userId, sanitizeCode(opts.code))
      : await uniqueCode(userId, name);
  const [row] = await db
    .insert(projects)
    .values({
      userId,
      name,
      code,
      position,
      ...(opts.color !== undefined ? { color: opts.color } : {}),
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      ...(opts.gitFolder !== undefined ? { gitFolder: opts.gitFolder } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
    })
    .returning();
  // Seed membership with exactly the requested ids (de-duped, FK-validated so
  // unknown ids drop). Empty ⇒ no members ⇒ the picker falls back to everyone.
  const validIds = await validUserIds([...new Set(opts.members ?? [])]);
  if (validIds.length)
    await db
      .insert(projectMembers)
      .values(validIds.map((uid) => ({ projectId: row.id, userId: uid })));
  // Every project gets its canvas here, not lazily on first use: `placement` is
  // resolved against the project's canvas, so a project without one silently
  // files everything into INBOX. Creating it up-front also keeps the 1:1
  // invariant true by construction rather than by convention.
  await createCanvas(userId, name, row.id);
  return { ...rowToProject(row), boards: [], members: validIds };
}

export async function updateProject(
  userId: string,
  id: string,
  patch: {
    name?: string;
    code?: string;
    color?: string;
    image?: string | null;
    gitFolder?: string | null;
    description?: string | null;
    /** Replace the member set (owner always kept). Omit to leave unchanged. */
    members?: string[];
  },
): Promise<Project | null> {
  const cur = (
    await db
      .select({ code: projects.code })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)
  )[0];
  if (!cur) return null;
  // A code edit only affects UNLOCKED tasks going forward (locked refs are
  // frozen). Keep it unique across the user's prefixes.
  const code =
    patch.code !== undefined
      ? await uniqueFrom(userId, sanitizeCode(patch.code), cur.code)
      : undefined;
  const [row] = await db
    .update(projects)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.image !== undefined ? { image: patch.image } : {}),
      ...(patch.gitFolder !== undefined ? { gitFolder: patch.gitFolder } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id))
    .returning();
  if (!row) return null;
  if (patch.members !== undefined) {
    await setProjectMembers(userId, id, patch.members);
  }
  return rowToProject(row);
}

/** Delete a project (cascades to its boards, and their tasks). */
export async function deleteProject(userId: string, id: string): Promise<boolean> {
  const res = await db
    .delete(projects)
    .where(eq(projects.id, id))
    .returning();
  return res.length > 0;
}

/* ---- Project members ----
   A curation layer for the assignee picker (see schema.ts): a task on a
   project offers only its members (the whole roster when it has none). The set
   is EXACTLY what's managed — nobody is auto-pinned, since the app is a shared
   workspace where anyone can manage any project's members. The picker still
   lets you manage whoever is already assigned even if they aren't a member
   (see the pickers' candidate union), so an auto-assigned task creator is never
   stranded. Membership references user ids; removing a member does NOT
   un-assign existing tasks (matches the loose coupling elsewhere). */

/** Keep only ids that are real user rows (guards the FK + drops junk). */
async function validUserIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids));
  const real = new Set(rows.map((r) => r.id));
  return ids.filter((id) => real.has(id));
}

/** The roster users belonging to a project (owner-scoped; [] if not theirs). */
export async function listProjectMembers(
  userId: string,
  projectId: string,
): Promise<PublicUser[]> {
  if (!(await ownsProject(projectId, userId))) return [];
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      color: users.color,
      avatarUrl: users.avatarUrl,
      language: users.language,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(users.name));
  return rows as PublicUser[];
}

/** Replace a project's whole member set (exactly the ids given). Returns the
 *  new ids, or null if the project doesn't exist. */
export async function setProjectMembers(
  userId: string,
  projectId: string,
  memberIds: string[],
): Promise<string[] | null> {
  if (!(await ownsProject(projectId, userId))) return null;
  const validIds = await validUserIds([...new Set(memberIds)]);
  // The neon-http driver has no interactive transactions — use `db.batch`,
  // which runs the statements in a single atomic HTTP transaction. Skip the
  // insert entirely when the set is empty (Drizzle rejects `.values([])`).
  const clear = db
    .delete(projectMembers)
    .where(eq(projectMembers.projectId, projectId));
  if (validIds.length === 0) {
    await clear;
  } else {
    await db.batch([
      clear,
      db
        .insert(projectMembers)
        .values(validIds.map((uid) => ({ projectId, userId: uid }))),
    ]);
  }
  return validIds;
}

/** Add one member to a project. Returns the new member id list, or null if the
 *  project isn't the user's or the member isn't a real user. */
export async function addProjectMember(
  userId: string,
  projectId: string,
  memberId: string,
): Promise<string[] | null> {
  if (!(await ownsProject(projectId, userId))) return null;
  const [valid] = await validUserIds([memberId]);
  if (!valid) return null;
  await db
    .insert(projectMembers)
    .values({ projectId, userId: valid })
    .onConflictDoNothing();
  return currentMemberIds(projectId);
}

/** Remove one member from a project. Returns the new member id list, or null if
 *  the project doesn't exist. */
export async function removeProjectMember(
  userId: string,
  projectId: string,
  memberId: string,
): Promise<string[] | null> {
  if (!(await ownsProject(projectId, userId))) return null;
  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, memberId),
      ),
    );
  return currentMemberIds(projectId);
}

/** Raw member ids for a project (no ownership check — callers gate first). */
async function currentMemberIds(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));
  return rows.map((r) => r.userId);
}

export async function createBoard(
  userId: string,
  projectId: string,
  name: string,
  opts: {
    code?: string;
    color?: string;
    image?: string | null;
    gitFolder?: string | null;
    description?: string | null;
  } = {},
): Promise<Board | null> {
  if (!(await ownsProject(projectId, userId))) return null;
  const position = await nextOrdinal(boards, eq(boards.projectId, projectId));
  // An explicit shortname takes precedence over the name-derived default;
  // either way it's made unique across the user's boards/projects.
  const code =
    opts.code !== undefined
      ? await uniqueFrom(userId, sanitizeCode(opts.code))
      : await uniqueCode(userId, name);
  const [row] = await db
    .insert(boards)
    .values({
      userId,
      projectId,
      name,
      code,
      position,
      ...(opts.color !== undefined ? { color: opts.color } : {}),
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      ...(opts.gitFolder !== undefined ? { gitFolder: opts.gitFolder } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
    })
    .returning();
  return rowToBoard(row);
}

export async function updateBoard(
  userId: string,
  id: string,
  patch: {
    name?: string;
    code?: string;
    color?: string;
    image?: string | null;
    gitFolder?: string | null;
    description?: string | null;
  },
): Promise<Board | null> {
  const cur = (
    await db
      .select({ code: boards.code })
      .from(boards)
      .where(eq(boards.id, id))
      .limit(1)
  )[0];
  if (!cur) return null;
  const code =
    patch.code !== undefined
      ? await uniqueFrom(userId, sanitizeCode(patch.code), cur.code)
      : undefined;
  const [row] = await db
    .update(boards)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.image !== undefined ? { image: patch.image } : {}),
      ...(patch.gitFolder !== undefined ? { gitFolder: patch.gitFolder } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updatedAt: new Date(),
    })
    .where(eq(boards.id, id))
    .returning();
  return row ? rowToBoard(row) : null;
}

/**
 * Reorder the boards within a project. `orderedIds` is the desired order;
 * each board is stamped with position = its index (1-based). Scoped to the
 * user + project so ids from other projects are ignored. Drives both the
 * project's Boards view and the sidebar order (both sort by position).
 */
export async function reorderBoards(
  userId: string,
  projectId: string,
  orderedIds: string[],
): Promise<boolean> {
  if (!(await ownsProject(projectId, userId))) return false;
  const now = new Date();
  await Promise.all(
    orderedIds.map((id, i) =>
      db
        .update(boards)
        .set({ position: i + 1, updatedAt: now })
        .where(and(eq(boards.id, id), eq(boards.projectId, projectId))),
    ),
  );
  return true;
}

/** Delete a board (cascades to its tasks + their logs). */
export async function deleteBoard(userId: string, id: string): Promise<boolean> {
  const res = await db
    .delete(boards)
    .where(eq(boards.id, id))
    .returning();
  return res.length > 0;
}

/* -------------------------------------------------------------------- */
/* Canvas / whiteboard                                                   */
/* -------------------------------------------------------------------- */

const rowToCanvasNode = (r: CanvasNodeRow): CanvasNode => ({
  id: r.id,
  kind: r.kind as CanvasNodeKind,
  content: r.content,
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
  color: r.color,
  position: r.position,
  data: (r.data as Record<string, unknown>) ?? {},
});

const rowToCanvas = (r: CanvasRow, nodes?: CanvasNode[]): Canvas => ({
  id: r.id,
  projectId: r.projectId,
  name: r.name,
  viewport: (r.viewport as Partial<CanvasViewport>) ?? {},
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
  ...(nodes ? { nodes } : {}),
});

/* Canvases are TEAM-VISIBLE (like Google calendars): every signed-in user can
   see and edit every canvas, so people can brainstorm on the same board in
   realtime. `canvases.userId` / `canvasNodes.userId` are kept only as "who
   created it" metadata — never a read/write fence. (Tasks created by
   convert-to-todos still land in the ACTING user's own todos.) */

/** True if the canvas exists (team-wide — not scoped to a user). */
async function canvasExists(id: string): Promise<boolean> {
  const row = (
    await db.select({ id: canvases.id }).from(canvases).where(eq(canvases.id, id)).limit(1)
  )[0];
  return !!row;
}

/** Every canvas on the instance, or just one project's (no nodes — the index
 *  only needs names). A project has exactly one canvas, so passing `projectId`
 *  returns at most a single row. */
export async function listCanvases(projectId?: string): Promise<Canvas[]> {
  const rows = await db
    .select()
    .from(canvases)
    .where(projectId ? eq(canvases.projectId, projectId) : undefined)
    .orderBy(asc(canvases.position));
  return rows.map((r) => rowToCanvas(r));
}

/**
 * The canvas flattened down to the two things the board views need: which bucket
 * every Section belongs to, and what each bucket's group is CALLED.
 *
 * The board views group cards by bucket, but a bucket is a canvas concept: it
 * lives in the node's `data` flags, and a task only points at a Section id. They
 * can't mount a canvas to find out (and shouldn't pull its nodes just to read a
 * handful of flags — drawings and images ride in the same `data` column). So the
 * lookup is resolved here, over a narrow select, and shipped as two small maps.
 *
 * **A section's bucket is its GROUP's bucket.** The group is what the eye reads
 * on the canvas — a lane sits inside a band and takes that band's meaning — so
 * membership is resolved by walking `data.groupId` to the group and reading the
 * flag there. The lane's own flag is only a fallback, for a lane whose group id
 * is missing or stale.
 *
 * That order matters, and getting it wrong is what sent cards to the wrong band:
 * the machine-managed lanes carry their kind as a flag on themselves
 * (`data.later === true`), but a lane the USER drew into a tray carries no flag
 * at all — just `groupId`. Classifying by the flag alone left those sections in
 * no bucket, so their tasks fell through to INBOX while sitting plainly inside
 * LATER on the canvas. Only the THIS WEEK group, whose flag was never on its
 * lanes, was resolved this way before.
 *
 * Team-wide — a task can be pinned to any canvas's section, so scoping this to
 * one USER would make other people's placements read as INBOX. Scoping it to one
 * PROJECT is different and safe: pass `projectId` and it reads only that
 * project's canvas, which is what a board view wants (it renders one project).
 * Omit it and every canvas is considered, for callers bucketing across projects.
 */
export async function listPlacementGroups(projectId?: string): Promise<{
  placements: PlacementMap;
  titles: PlacementTitles;
}> {
  const only = projectId ? await canvasIdForProject(projectId) : null;
  // Asked for a project that has no canvas: no sections, hence no buckets. Not
  // the same as "no filter" — falling through would bucket every OTHER project's
  // sections into this project's board view.
  if (projectId && !only) return { placements: {}, titles: {} };
  const rows = await db
    .select({
      id: canvasNodes.id,
      canvasId: canvasNodes.canvasId,
      kind: canvasNodes.kind,
      content: canvasNodes.content,
      data: canvasNodes.data,
    })
    .from(canvasNodes)
    .where(
      and(
        inArray(canvasNodes.kind, ["section", "section_group"]),
        ...(only ? [eq(canvasNodes.canvasId, only)] : []),
      ),
    )
    // Deterministic, so the title pass below can't name a bucket differently
    // from one call to the next when two groups compete for it.
    .orderBy(asc(canvasNodes.canvasId), asc(canvasNodes.id));

  /** Every group that IS a bucket: the trays by their own flag, plus the one
   *  hand-starred THIS WEEK group. */
  const groupPlacement = new Map<string, TaskPlacement>();
  for (const row of rows) {
    if (row.kind !== "section_group") continue;
    const data = (row.data ?? {}) as Record<string, unknown>;
    const placement =
      systemGroupOf({ data }) ?? (data.thisWeek === true ? "thisWeek" : null);
    if (placement) groupPlacement.set(row.id, placement);
  }

  /* Names come from ONE canvas wherever possible — the one holding the starred
   * THIS WEEK group. Mixing names across canvases would head one band with your
   * name and the next with someone else's. A bucket the preferred canvas doesn't
   * draw is then named by whoever does draw it, and one nobody draws keeps its
   * default (`placementTitle`). Moot when `projectId` scoped us to a single
   * canvas, which is the common case now that canvases are per-project. */
  const preferred =
    rows.find(
      (r) =>
        r.kind === "section_group" &&
        ((r.data ?? {}) as Record<string, unknown>).thisWeek === true,
    )?.canvasId ?? null;

  const titles: PlacementTitles = {};
  for (const pass of [true, false]) {
    for (const row of rows) {
      const placement = groupPlacement.get(row.id);
      if (!placement) continue;
      if ((row.canvasId === preferred) !== pass) continue;
      const name = (row.content ?? "").trim();
      if (name && titles[placement] === undefined) titles[placement] = name;
    }
  }

  const placements: PlacementMap = {};
  for (const row of rows) {
    if (row.kind !== "section") continue;
    const data = (row.data ?? {}) as Record<string, unknown>;
    const viaGroup =
      typeof data.groupId === "string"
        ? groupPlacement.get(data.groupId)
        : undefined;
    const placement = viaGroup ?? systemGroupOf({ data });
    if (placement) placements[row.id] = placement;
  }
  return { placements, titles };
}

/** Just the `sectionId → placement` half, for callers that only bucket cards. */
export async function listPlacementSections(
  projectId?: string,
): Promise<PlacementMap> {
  return (await listPlacementGroups(projectId)).placements;
}

/** One canvas with all its nodes (team-wide; null if it doesn't exist). */
export async function getCanvas(id: string): Promise<Canvas | null> {
  const row = (
    await db.select().from(canvases).where(eq(canvases.id, id)).limit(1)
  )[0];
  if (!row) return null;
  const nodeRows = await db
    .select()
    .from(canvasNodes)
    .where(eq(canvasNodes.canvasId, id))
    .orderBy(asc(canvasNodes.position));
  return rowToCanvas(row, nodeRows.map(rowToCanvasNode));
}

export async function createCanvas(
  userId: string,
  name: string,
  projectId: string,
): Promise<Canvas> {
  // One canvas per project (`canvases_project_idx`). Surfacing it as a
  // ValidationError rather than letting the unique violation escape as a 500:
  // "this project already has a canvas" is a normal answer, not a fault.
  const existing = await canvasIdForProject(projectId);
  if (existing)
    throw new ValidationError("That project already has a canvas.");
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${canvases.position}), 0)` })
    .from(canvases);
  const [row] = await db
    .insert(canvases)
    .values({ userId, name, projectId, position: Number(max) + 1 })
    .returning();
  return rowToCanvas(row, []);
}

export async function updateCanvas(
  id: string,
  patch: { name?: string; viewport?: CanvasViewport },
): Promise<Canvas | null> {
  const [row] = await db
    .update(canvases)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.viewport !== undefined ? { viewport: patch.viewport } : {}),
      updatedAt: new Date(),
    })
    .where(eq(canvases.id, id))
    .returning();
  return row ? rowToCanvas(row) : null;
}

/** Delete a canvas (cascades to its nodes). */
export async function deleteCanvas(id: string): Promise<boolean> {
  const res = await db.delete(canvases).where(eq(canvases.id, id)).returning();
  return res.length > 0;
}

/** One node in a batch save. Ids are CLIENT-generated UUIDs so the editor can
 *  reference a node the instant it's drawn; the save is an idempotent upsert. */
export interface CanvasNodeInput {
  id?: string;
  kind: CanvasNodeKind;
  content?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string | null;
  position?: number;
  data?: Record<string, unknown>;
}

/**
 * The canvas editor's debounced save: upsert some nodes and delete others in
 * one call. Upserts are keyed on the node id (client-generated), and the
 * on-conflict update is fenced to rows this user owns on this canvas, so a
 * stray id can never overwrite someone else's node. Returns the refreshed
 * canvas (with nodes), or null if the canvas isn't the user's.
 */
export async function saveCanvasNodes(
  userId: string,
  canvasId: string,
  changes: { upserts?: CanvasNodeInput[]; deletes?: string[] },
): Promise<Canvas | null> {
  if (!(await canvasExists(canvasId))) return null;
  const now = new Date();
  const deletes = changes.deletes ?? [];
  const upserts = changes.upserts ?? [];

  // Team canvas: any member can delete/edit any node — fence by canvas only.
  if (deletes.length) {
    await db
      .delete(canvasNodes)
      .where(
        and(eq(canvasNodes.canvasId, canvasId), inArray(canvasNodes.id, deletes)),
      );
  }

  await Promise.all(
    upserts.map((n) => {
      const values = {
        kind: n.kind,
        content: n.content ?? "",
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        color: n.color ?? null,
        position: n.position ?? 0,
        data: n.data ?? {},
      };
      return db
        .insert(canvasNodes)
        // `userId` stamps the creator on insert; updates never touch it.
        .values({ ...(n.id ? { id: n.id } : {}), userId, canvasId, ...values })
        .onConflictDoUpdate({
          target: canvasNodes.id,
          set: { ...values, updatedAt: now },
          setWhere: eq(canvasNodes.canvasId, canvasId),
        });
    }),
  );

  await db.update(canvases).set({ updatedAt: now }).where(eq(canvases.id, canvasId));

  return getCanvas(canvasId);
}

/* -------------------------------------------------------------------- */
/* AI-readable Markdown rendering                                        */
/* -------------------------------------------------------------------- */

/** Render the whole board as compact Markdown — great for an AI to skim.
 *  `names` maps assignee user ids → display names so assignees render as
 *  `@name`; without it they fall back to the raw id. */
export function toMarkdown(tree: TaskDTO[], names?: Map<string, string>): string {
  const order: TaskStatus[] = [
    "review",
    "building",
    "analyzing",
    "analyzed",
    "todo",
    "backlog",
    "done",
  ];
  const lines: string[] = ["# Tasks", ""];
  for (const status of order) {
    const group = tree.filter((t) => t.status === status);
    if (!group.length) continue;
    lines.push(`## ${STATUS_LABEL[status]}`, "");
    for (const t of group) lines.push(...taskLines(t, 0, names));
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

/** Map of every user's id → display name, for rendering assignees as `@name`. */
export async function userNameMap(): Promise<Map<string, string>> {
  const rows = await db.select({ id: users.id, name: users.name }).from(users);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function taskLines(
  t: TaskDTO,
  depth: number,
  names?: Map<string, string>,
): string[] {
  const pad = "  ".repeat(depth);
  const box = t.status === "done" ? "[x]" : "[ ]";
  const meta: string[] = [];
  if (t.status !== "backlog" && t.status !== "todo" && t.status !== "done")
    meta.push(`status:${t.status}`);
  if (t.importance) meta.push(`importance:${t.importance}`);
  if (t.value != null) meta.push(`value:${t.value}`);
  if (t.difficulty != null) meta.push(`diff:${t.difficulty}`);
  if (t.assigneeIds?.length)
    meta.push(...t.assigneeIds.map((a) => `@${names?.get(a) ?? a}`));
  if (t.startDate) meta.push(`start:${t.startDate}`);
  if (t.dueDate) meta.push(`due:${t.dueDate}`);
  if (t.recurrence && t.recurrence !== "none") meta.push(`↻${t.recurrence}`);
  if (t.dependsOn?.length) meta.push(`⛔${t.dependsOn.length}`);
  if (t.attachments?.length) meta.push(`📎${t.attachments.length}`);
  const tail = meta.length ? `  _(${meta.join(" · ")})_` : "";
  // Show the human code up front; keep the raw id (in backticks) for tools.
  const codeTag = t.code ? `\`${t.code}\` ` : "";
  const lines = [`${pad}- ${box} ${codeTag}**${t.title}** \`${t.id}\`${tail}`];
  if (t.description) lines.push(`${pad}  ${t.description}`);
  for (const s of t.subtasks ?? []) lines.push(...taskLines(s, depth + 1, names));
  return lines;
}
