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
import { currentLogContext, type LogSource } from "./log-context";
import { deriveCode, sanitizeCode, formatCode } from "@/lib/refs";
import { MAX_BULK_OPS, type OpResult } from "@/lib/bulk";
import { weekLaneId, systemLaneId } from "@/lib/sections";
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
   Every "what happened between X and Y" read goes through `dateWindow`. It
   exists because each caller used to hand-roll `new Date(from)` / `new Date(to)`
   and compare inclusively, which made the most natural window of all — a single
   day, from = to — resolve to the empty range [00:00, 00:00]. */

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** How far `tz` is ahead of UTC at a given instant, in ms (0 for UTC). */
function tzOffsetMs(at: Date, tz: string): number {
  if (tz === "UTC") return 0;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // hour12:false renders midnight as "24" on some ICU builds — fold it back.
  const asIfUtc = Date.UTC(
    n("year"),
    n("month") - 1,
    n("day"),
    n("hour") % 24,
    n("minute"),
    n("second"),
  );
  return asIfUtc - at.getTime();
}

/** The instant at which `YYYY-MM-DD` (+ `plusDays`) begins in `tz`. */
function dayStart(day: string, tz: string, plusDays = 0): Date {
  const [y, m, d] = day.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d + plusDays);
  // The offset sampled at the naive instant is right except when the window
  // edge sits across a DST change; one correction lands it (offsets shift by
  // an hour, day boundaries are 24 apart).
  const off = tzOffsetMs(new Date(naive), tz);
  const first = naive - off;
  return new Date(first - (tzOffsetMs(new Date(first), tz) - off));
}

/**
 * Parse a caller's date window into a HALF-OPEN instant range `[start, end)`.
 *
 * Both ends are optional and accept either a bare day (`YYYY-MM-DD`) or a full
 * ISO instant. A bare day means the WHOLE day in `tz`, so `from = to =
 * "2026-08-04"` covers 04T00:00 → 05T00:00 — "what happened on the 4th?".
 *
 * `end` is EXCLUSIVE: compare with `< end`, never `<=`. That way an event at
 * 23:59:59.999 counts and one at the next midnight does not, and consecutive
 * windows tile without double-counting.
 */
export function dateWindow(
  from?: string,
  to?: string,
  tz = "UTC",
): { start?: Date; end?: Date } {
  return {
    start: from
      ? DAY_ONLY.test(from)
        ? dayStart(from, tz)
        : new Date(from)
      : undefined,
    end: to
      ? DAY_ONLY.test(to)
        ? dayStart(to, tz, 1)
        : new Date(to)
      : undefined,
  };
}

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
 * Where a "this week" task goes: the section for `boardId` inside the canvas's
 * THIS WEEK group (the group flagged `data.thisWeek`), or null if no group is
 * flagged — in which case the caller leaves the task unpinned and it shows up in
 * INBOX as usual.
 *
 * An EXISTING member section for that board always wins, so the user's own lanes
 * ("Platform", "Racing", …) are what agents drop work into. Only when the group
 * doesn't cover the board yet do we return the DERIVED lane id (`weekLaneId`) —
 * a node the canvas will materialise inside the group on its next reconcile.
 * Writing the node here instead would be invisible to any open canvas, since
 * nodes live in Liveblocks storage, not in the row we'd insert.
 *
 * Reads `data` straight out of jsonb: the flag is a canvas-editor toggle whose
 * writes reach Postgres on the editor's debounced save, so it can lag a few
 * seconds behind the star being clicked. Nothing else depends on it being
 * instant.
 */
export async function resolveThisWeekSection(
  boardId: string | null,
): Promise<string | null> {
  return resolvePlacementSection("thisWeek", boardId);
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
export async function resolvePlacementSection(
  placement: TaskPlacement,
  boardId: string | null,
): Promise<string | null> {
  if (placement === "inbox") return null;
  // Each placement's name IS the `data` flag that marks its group, so the query
  // is the same for all of them.
  const flag = placement;

  const groups = await db
    .select({ id: canvasNodes.id, canvasId: canvasNodes.canvasId })
    .from(canvasNodes)
    .where(
      and(
        eq(canvasNodes.kind, "section_group"),
        sql`${canvasNodes.data}->>${flag} = 'true'`,
      ),
    )
    .orderBy(asc(canvasNodes.id));
  const group = groups[0];
  if (!group) return null;

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

  return placement === "thisWeek"
    ? weekLaneId(group.id, boardId)
    : systemLaneId(placement, group.canvasId, boardId);
}

/** How a placement change reads on the activity timeline. Every move is
 *  announced — a card that relocated itself with no explanation is the thing
 *  these lines exist to prevent. */
const PLACEMENT_LOG: Record<TaskPlacement, string> = {
  inbox: "📥 Moved back to INBOX",
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
): Promise<string | null> {
  if (!handle) return null;

  // Fast path: a direct UUID (what most callers already pass).
  const direct = (
    await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, handle))
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
      .where(sql`upper(${tasks.ref}) = ${norm}`)
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
      .where(and(eq(tasks.seq, seq), eq(tasks.refLocked, false))),
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
      .where(eq(tasks.id, id))
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

  if (filter?.includeDone === false) conds.push(ne(tasks.status, "done"));

  const tz = filter?.tz ?? "UTC";
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
      db.select().from(tasks).where(eq(tasks.parentId, id)).orderBy(...TASK_ORDER),
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
  const position = await nextPosition(userId, status, parentId);
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
      : await resolvePlacementSection(placement, boardId);
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
    if (
      placed === null &&
      statusChanged &&
      statusImpliesThisWeek(patch.status) &&
      current.canvasSectionId === null
    )
      placed = "thisWeek";
  }
  if (placed !== null) {
    const target = await resolvePlacementSection(placed, current.boardId);
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
    canvasSectionId = await resolvePlacementSection(asked, boardId);
    placed = canvasSectionId !== current.canvasSectionId ? asked : null;
  } else {
    canvasSectionId = boardChanged ? null : current.canvasSectionId;
  }
  // …and an agent moving the task into work files it on THIS WEEK's board, the
  // same rule `updateTask` applies — but only if nothing else claimed it, so a
  // card the user filed by hand (or a fresh pin above) stays where it is.
  if (
    canvasSectionId === null &&
    statusChanged &&
    statusImpliesThisWeek(status)
  ) {
    canvasSectionId = await resolvePlacementSection("thisWeek", boardId);
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

/** Complete or reopen (reopen sends it back to To Do, like the UI). */
export async function completeTask(
  handle: string,
  done = true,
  userId: string,
  author = "You",
): Promise<TaskDTO | null> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return null;
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

/** Delete a task (cascades to its logs + attachment rows; subtasks are
 *  re-parented to top, and re-positioned at the end of their new root group).
 *  Blob objects are cleaned up first, since the DB cascade drops the rows but
 *  not the files in Vercel Blob. */
export async function deleteTask(handle: string, userId: string): Promise<boolean> {
  const id = await resolveTaskId(handle, userId);
  if (!id) return false;
  const attachmentRows = await db
    .select({ url: taskAttachments.url })
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, id));
  if (attachmentRows.length) {
    await delBlobs(attachmentRows.map((a) => a.url));
  }
  // Subtasks outlive their parent, but a subtask's `position` was allocated
  // INSIDE the parent's group — it means "3rd under that parent", nothing at all
  // at root level. Promoting it as-is drops the orphan into the middle of its
  // section's ordering, next to unrelated tasks. So re-stamp each one at the end
  // of the root group it's joining; positions are per (status, parent), hence a
  // separate running counter per status.
  const orphans = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.parentId, id))
    .orderBy(...TASK_ORDER);
  if (orphans.length) {
    const nextByStatus = new Map<TaskStatus, number>();
    for (const status of new Set(orphans.map((o) => o.status)))
      nextByStatus.set(status, await nextPosition(userId, status, null));
    const [first, ...rest] = orphans.map((o) => {
      const position = nextByStatus.get(o.status)!;
      nextByStatus.set(o.status, position + 1);
      return db
        .update(tasks)
        .set({ parentId: null, position })
        .where(eq(tasks.id, o.id));
    });
    // One atomic HTTP transaction (the neon-http driver has no interactive
    // ones), so a partial promotion can't leave orphans on a stale position.
    await db.batch([first, ...rest]);
  }
  const res = await db
    .delete(tasks)
    .where(eq(tasks.id, id))
    .returning();
  return res.length > 0;
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
 * "invisible if not yours" convention.
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
): Promise<{ updated: number; skipped: string[]; tasks: TaskDTO[] }> {
  // 1. Resolve each handle (UUID or ref) to a canonical UUID the user owns;
  //    anything that doesn't resolve is reported as skipped, not silently lost.
  const resolved = await Promise.all(ids.map((h) => resolveTaskId(h, userId)));
  const skipped = ids.filter((_, i) => !resolved[i]);
  const resolvedIds = resolved.filter((x): x is string => x !== null);
  // Grab prior status + assignees for the activity log (resolution already
  // scoped to user); the assignees tell us which rows the claim below touched.
  const owned = resolvedIds.length
    ? await db
        .select({
          id: tasks.id,
          status: tasks.status,
          assigneeIds: tasks.assigneeIds,
          // For THIS WEEK placement below: the target depends on each task's own
          // board, and the status-implied move only applies to unpinned tasks.
          boardId: tasks.boardId,
          canvasSectionId: tasks.canvasSectionId,
        })
        .from(tasks)
        .where(inArray(tasks.id, resolvedIds))
    : [];
  const ownedIds = owned.map((r) => r.id);
  if (!ownedIds.length) return { updated: 0, skipped, tasks: [] };

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
      const byBoard = new Map<string | null, (typeof owned)[number][]>();
      for (const r of movable) {
        const list = byBoard.get(r.boardId);
        if (list) list.push(r);
        else byBoard.set(r.boardId, [r]);
      }
      for (const [boardId, group] of byBoard) {
        const section = await resolvePlacementSection(target, boardId);
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
  const conds: (SQL | undefined)[] = [...inWindow(taskStatusEvents.at, w)];
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

/** Every canvas on the instance (no nodes — the index only needs names). */
export async function listCanvases(): Promise<Canvas[]> {
  const rows = await db.select().from(canvases).orderBy(asc(canvases.position));
  return rows.map((r) => rowToCanvas(r));
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
): Promise<Canvas> {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${canvases.position}), 0)` })
    .from(canvases);
  const [row] = await db
    .insert(canvases)
    .values({ userId, name, position: Number(max) + 1 })
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
