/*
  ====================================================================
  TASK SERVICE — the one place task logic lives.
  The web UI (via /api/tasks), the REST API, and the MCP server all
  call THESE functions. One code path for humans and AI => no drift.
  Returns the app's `Task` shape (see ../types.ts) so screens and AIs
  get the same clean, self-describing objects.
  ====================================================================
*/

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { del } from "@vercel/blob";
import { blobAuth } from "@/lib/blob";
import { db } from "./client";
import {
  tasks,
  taskLogs,
  taskAttachments,
  projects,
  boards,
  type TaskRow,
  type TaskAttachmentRow,
  type ProjectRow,
  type BoardRow,
} from "./schema";
import { STATUS_LABEL } from "@/lib/statuses";
import { ConflictError } from "@/lib/api";
import { daysAgo } from "@/lib/format";
import type {
  Task,
  TaskStatus,
  Recurrence,
  FibPoints,
  CustomFieldValue,
  TaskLogEntry,
  Attachment,
  Project,
  Board,
} from "@/lib/types";

/** A Task plus the fields AIs care about (nesting/order/timestamps). */
export interface TaskDTO extends Task {
  parentId: string | null;
  position: number;
  statusSince: string;
  createdAt: string;
  subtasks?: TaskDTO[];
}

const iso = (d: Date | string | null) =>
  d == null ? undefined : (d instanceof Date ? d.toISOString() : d);

const rowToAttachment = (r: TaskAttachmentRow): Attachment => ({
  id: r.id,
  filename: r.filename,
  mimeType: r.mimeType,
  size: r.size,
  url: r.url,
  createdAt: iso(r.createdAt)!,
});

function rowToTask(
  row: TaskRow,
  commentCount: number,
  attachments: Attachment[] = [],
): TaskDTO {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assignees: row.assignees ?? [],
    startDate: row.startDate ?? undefined,
    dueDate: row.dueDate ?? undefined,
    recurrence: row.recurrence,
    dependsOn: row.dependsOn ?? [],
    customFields: (row.customFields as Record<string, CustomFieldValue>) ?? {},
    value: (row.value as FibPoints | null) ?? undefined,
    difficulty: (row.difficulty as FibPoints | null) ?? undefined,
    description: row.description ?? undefined,
    tags: row.tags ?? [],
    commentCount: commentCount || undefined,
    boardId: row.boardId,
    parentId: row.parentId,
    position: row.position,
    statusSince: iso(row.statusSince)!,
    completedAt: iso(row.completedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt),
    attachments: attachments.length ? attachments : undefined,
  };
}

/** Nest flat rows into a tree, preserving position order at each level. */
function buildTree(
  rows: TaskRow[],
  counts: Map<string, number>,
  attachments: Map<string, Attachment[]>,
): TaskDTO[] {
  const byId = new Map<string, TaskDTO>();
  for (const r of rows)
    byId.set(r.id, rowToTask(r, counts.get(r.id) ?? 0, attachments.get(r.id)));
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

/** Comment counts for one user's tasks (joined so we never leak others'). */
async function commentCounts(userId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ taskId: taskLogs.taskId, n: sql<number>`count(*)::int` })
    .from(taskLogs)
    .innerJoin(tasks, eq(taskLogs.taskId, tasks.id))
    .where(and(eq(taskLogs.kind, "comment"), eq(tasks.userId, userId)))
    .groupBy(taskLogs.taskId);
  return new Map(rows.map((r) => [r.taskId, r.n]));
}

/** Attachments for one user's tasks, grouped by taskId (joined so we
 *  never leak others'). Ordered oldest-first. */
async function attachmentsByTask(
  userId: string,
): Promise<Map<string, Attachment[]>> {
  const rows = await db
    .select({ a: taskAttachments })
    .from(taskAttachments)
    .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
    .where(eq(tasks.userId, userId))
    .orderBy(asc(taskAttachments.createdAt));
  const map = new Map<string, Attachment[]>();
  for (const { a } of rows) {
    const list = map.get(a.taskId) ?? [];
    list.push(rowToAttachment(a));
    map.set(a.taskId, list);
  }
  return map;
}

/** True if the task exists and belongs to the user. */
async function ownsTask(id: string, userId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
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
  await db.insert(taskLogs).values({ taskId, kind, message, author });
}

/* -------------------------------------------------------------------- */
/* Reads                                                                 */
/* -------------------------------------------------------------------- */

/** Optional scoping for task reads. */
export interface TaskFilter {
  /** Only tasks on this board. */
  boardId?: string;
  /** Only tasks whose board belongs to this project. */
  projectId?: string;
}

/** Build the WHERE for a user's tasks, narrowed by an optional filter. */
function taskWhere(userId: string, filter?: TaskFilter): SQL | undefined {
  const conds: (SQL | undefined)[] = [eq(tasks.userId, userId)];
  if (filter?.boardId) conds.push(eq(tasks.boardId, filter.boardId));
  if (filter?.projectId) {
    conds.push(
      inArray(
        tasks.boardId,
        db
          .select({ id: boards.id })
          .from(boards)
          .where(
            and(eq(boards.userId, userId), eq(boards.projectId, filter.projectId)),
          ),
      ),
    );
  }
  return and(...conds);
}

/** All of a user's tasks as a nested tree, ordered by status then position. */
export async function listTasks(
  userId: string,
  filter?: TaskFilter,
): Promise<TaskDTO[]> {
  const [rows, counts, attachments] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(taskWhere(userId, filter))
      .orderBy(asc(tasks.position)),
    commentCounts(userId),
    attachmentsByTask(userId),
  ]);
  return buildTree(rows, counts, attachments);
}

/** Flat list (no nesting) — handy for AIs that just want every task. */
export async function listTasksFlat(
  userId: string,
  filter?: TaskFilter,
): Promise<TaskDTO[]> {
  const [rows, counts, attachments] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(taskWhere(userId, filter))
      .orderBy(asc(tasks.position)),
    commentCounts(userId),
    attachmentsByTask(userId),
  ]);
  return rows.map((r) =>
    rowToTask(r, counts.get(r.id) ?? 0, attachments.get(r.id)),
  );
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
    if (t.status === "in-progress" || t.status === "planned") return true;
    return t.dueDate ? daysAgo(t.dueDate, ref) >= 0 : false;
  });
}

/** A user's tasks with the given ids (flat, position order, comment counts).
 *  Used by the bulk paths to return the refreshed affected set in one shot. */
async function tasksByIds(userId: string, ids: string[]): Promise<TaskDTO[]> {
  if (!ids.length) return [];
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)))
      .orderBy(asc(tasks.position)),
    commentCounts(userId),
  ]);
  return rows.map((r) => rowToTask(r, counts.get(r.id) ?? 0));
}

export async function getTask(
  id: string,
  userId: string,
): Promise<{ task: TaskDTO; logs: TaskLogEntry[] } | null> {
  const row = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
  )[0];
  if (!row) return null;
  const [logRows, attachmentRows] = await Promise.all([
    db
      .select()
      .from(taskLogs)
      .where(eq(taskLogs.taskId, id))
      .orderBy(asc(taskLogs.at)),
    db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.taskId, id))
      .orderBy(asc(taskAttachments.createdAt)),
  ]);
  const cCount = logRows.filter((l) => l.kind === "comment").length;
  return {
    task: rowToTask(row, cCount, attachmentRows.map(rowToAttachment)),
    logs: logRows.map((l) => ({
      id: l.id,
      at: iso(l.at)!,
      kind: l.kind,
      message: l.message,
      author: l.author ?? undefined,
    })),
  };
}

/** Cheap change-cursor for a user's board: moves on any create/update/
 *  move/complete/delete/comment (every mutation bumps updatedAt; deletes
 *  drop the row count). Lets clients poll "did anything change?" without
 *  re-fetching the whole list. One indexed aggregate (tasks_user_idx). */
export async function getChangeCursor(userId: string): Promise<string> {
  const [taskAgg, boardAgg, projectAgg] = await Promise.all([
    db
      .select({
        n: sql<number>`count(*)::int`,
        u: sql<number>`coalesce(extract(epoch from max(${tasks.updatedAt}))::bigint, 0)`,
      })
      .from(tasks)
      .where(eq(tasks.userId, userId)),
    db
      .select({
        n: sql<number>`count(*)::int`,
        u: sql<number>`coalesce(extract(epoch from max(${boards.updatedAt}))::bigint, 0)`,
      })
      .from(boards)
      .where(eq(boards.userId, userId)),
    db
      .select({
        n: sql<number>`count(*)::int`,
        u: sql<number>`coalesce(extract(epoch from max(${projects.updatedAt}))::bigint, 0)`,
      })
      .from(projects)
      .where(eq(projects.userId, userId)),
  ]);
  const [{ n, u }] = taskAgg;
  const [{ n: bn, u: bu }] = boardAgg;
  const [{ n: pn, u: pu }] = projectAgg;
  return `${n}:${u}:${bn}:${bu}:${pn}:${pu}`;
}

/* -------------------------------------------------------------------- */
/* Writes                                                                */
/* -------------------------------------------------------------------- */

export interface CreateTaskInput {
  title: string;
  status?: TaskStatus;
  assignees?: string[];
  startDate?: string;
  dueDate?: string;
  recurrence?: Recurrence;
  dependsOn?: string[];
  customFields?: Record<string, CustomFieldValue>;
  value?: FibPoints;
  difficulty?: FibPoints;
  description?: string;
  tags?: string[];
  parentId?: string | null;
  boardId?: string | null;
}

/** Next position at the end of a user's (status, parent) group. */
async function nextPosition(
  userId: string,
  status: TaskStatus,
  parentId: string | null,
): Promise<number> {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, status),
        parentId === null
          ? sql`${tasks.parentId} is null`
          : eq(tasks.parentId, parentId),
      ),
    );
  return Number(max) + 1;
}

export async function createTask(
  input: CreateTaskInput,
  userId: string,
  author = "You",
): Promise<TaskDTO> {
  const status = input.status ?? "backlog";
  // Only nest under a parent the user actually owns; otherwise top-level.
  const parentId =
    input.parentId && (await ownsTask(input.parentId, userId))
      ? input.parentId
      : null;
  // Only place on a board the user owns; otherwise leave unassigned.
  const boardId =
    input.boardId && (await ownsBoard(input.boardId, userId))
      ? input.boardId
      : null;
  const position = await nextPosition(userId, status, parentId);
  const [row] = await db
    .insert(tasks)
    .values({
      userId,
      title: input.title,
      status,
      assignees: input.assignees ?? [],
      startDate: input.startDate,
      dueDate: input.dueDate,
      recurrence: input.recurrence,
      dependsOn: input.dependsOn ?? [],
      customFields: input.customFields ?? {},
      value: input.value,
      difficulty: input.difficulty,
      description: input.description,
      tags: input.tags ?? [],
      parentId,
      boardId,
      position,
      completedAt: status === "done" ? new Date() : null,
    })
    .returning();
  await log(row.id, "created", `Created in ${STATUS_LABEL[status]}`, author);
  return rowToTask(row, 0);
}

export interface UpdateTaskInput {
  title?: string;
  status?: TaskStatus;
  assignees?: string[];
  startDate?: string | null;
  dueDate?: string | null;
  recurrence?: Recurrence;
  dependsOn?: string[];
  customFields?: Record<string, CustomFieldValue>;
  value?: FibPoints | null;
  difficulty?: FibPoints | null;
  description?: string | null;
  tags?: string[];
}

export async function updateTask(
  id: string,
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
  const current = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
  )[0];
  if (!current) return null;
  if (expectedUpdatedAt !== undefined && iso(current.updatedAt) !== expectedUpdatedAt)
    throw new ConflictError(rowToTask(current, 0));

  const now = new Date();
  const values: Record<string, unknown> = { updatedAt: now };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.assignees !== undefined) values.assignees = patch.assignees;
  if (patch.startDate !== undefined) values.startDate = patch.startDate;
  if (patch.dueDate !== undefined) values.dueDate = patch.dueDate;
  if (patch.recurrence !== undefined) values.recurrence = patch.recurrence;
  if (patch.dependsOn !== undefined) values.dependsOn = patch.dependsOn;
  if (patch.customFields !== undefined) values.customFields = patch.customFields;
  if (patch.value !== undefined) values.value = patch.value;
  if (patch.difficulty !== undefined) values.difficulty = patch.difficulty;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.tags !== undefined) values.tags = patch.tags;

  const statusChanged =
    patch.status !== undefined && patch.status !== current.status;
  if (statusChanged) {
    values.status = patch.status;
    values.statusSince = now;
    // Track completion: stamp on entering "done", clear on leaving it.
    if (patch.status === "done") values.completedAt = now;
    else if (current.status === "done") values.completedAt = null;
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

  if (statusChanged) {
    await log(
      id,
      "status",
      `Status: ${STATUS_LABEL[current.status]} → ${STATUS_LABEL[patch.status!]}`,
      author,
    );
  }
  const counts = await commentCounts(userId);
  return rowToTask(row, counts.get(id) ?? 0);
}

/** Move within/across groups: change parent, status, and/or position. */
export async function moveTask(
  id: string,
  target: {
    parentId?: string | null;
    status?: TaskStatus;
    position?: number;
    boardId?: string | null;
  },
  userId: string,
  author = "You",
): Promise<TaskDTO | null> {
  const current = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
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

  const [row] = await db
    .update(tasks)
    .set({
      status,
      parentId,
      boardId,
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

  if (target.parentId !== undefined && target.parentId !== current.parentId) {
    const parentTitle = target.parentId
      ? (
          await db
            .select()
            .from(tasks)
            .where(and(eq(tasks.id, target.parentId), eq(tasks.userId, userId)))
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
            .where(and(eq(boards.id, boardId), eq(boards.userId, userId)))
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
  } else {
    await log(id, "moved", `Reordered in ${STATUS_LABEL[status]}`, author);
  }
  const counts = await commentCounts(userId);
  return rowToTask(row, counts.get(id) ?? 0);
}

/** Complete or reopen (reopen sends it back to Planned, like the UI). */
export async function completeTask(
  id: string,
  done = true,
  userId: string,
  author = "You",
): Promise<TaskDTO | null> {
  return updateTask(
    id,
    { status: done ? "done" : "planned" },
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

export async function addComment(
  id: string,
  message: string,
  userId: string,
  author = "You",
): Promise<TaskLogEntry | null> {
  if (!(await ownsTask(id, userId))) return null;
  const [row] = await db
    .insert(taskLogs)
    .values({ taskId: id, kind: "comment", message, author })
    .returning();
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, id));
  return { id: row.id, at: iso(row.at)!, kind: "comment", message: row.message };
}

/** Delete a task (cascades to its logs + attachment rows; subtasks are
 *  re-parented to top). Blob objects are cleaned up first, since the DB
 *  cascade drops the rows but not the files in Vercel Blob. */
export async function deleteTask(id: string, userId: string): Promise<boolean> {
  if (!(await ownsTask(id, userId))) return false;
  const attachmentRows = await db
    .select({ url: taskAttachments.url })
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, id));
  if (attachmentRows.length) {
    await delBlobs(attachmentRows.map((a) => a.url));
  }
  await db
    .update(tasks)
    .set({ parentId: null })
    .where(and(eq(tasks.parentId, id), eq(tasks.userId, userId)));
  const res = await db
    .delete(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
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
};

/** One step in a `bulkApply` batch. Executed in array order. */
export type BulkOp =
  | { op: "create"; input: CreateTaskInput }
  | { op: "update"; id: string; patch: UpdateTaskInput }
  | { op: "move"; id: string; target: MoveTarget }
  | { op: "complete"; id: string; done?: boolean }
  | { op: "comment"; id: string; message: string }
  | { op: "delete"; id: string };

/** Outcome of a single op — so a partial failure is visible, not silent. */
export interface OpResult {
  op: BulkOp["op"];
  ok: boolean;
  /** The affected task id (the new id for a successful `create`). */
  id?: string;
  /** Present when `ok` is false. */
  error?: string;
}

/** Hard cap on how many ops one `bulkApply` batch runs; the rest are dropped
 *  (and reported via `truncated`) rather than silently ignored. */
export const MAX_BULK_OPS = 200;

/** Human summary of the constant (per-batch) part of a bulk patch — the
 *  per-task status transition is appended separately by `bulkUpdate`. */
function describeBulkPatch(patch: UpdateTaskInput): string {
  const parts: string[] = [];
  if (patch.title !== undefined) parts.push(`Title → “${patch.title}”`);
  if (patch.assignees !== undefined)
    parts.push(
      patch.assignees.length
        ? `Assignees → ${patch.assignees.join(", ")}`
        : "Assignees cleared",
    );
  if (patch.tags !== undefined)
    parts.push(
      patch.tags.length
        ? `Tags → ${patch.tags.map((t) => `#${t}`).join(" ")}`
        : "Tags cleared",
    );
  if (patch.value !== undefined)
    parts.push(patch.value == null ? "Value cleared" : `Value → ${patch.value}`);
  if (patch.difficulty !== undefined)
    parts.push(
      patch.difficulty == null ? "Difficulty cleared" : `Difficulty → ${patch.difficulty}`,
    );
  if (patch.startDate !== undefined)
    parts.push(patch.startDate == null ? "Start date cleared" : `Start → ${patch.startDate}`);
  if (patch.dueDate !== undefined)
    parts.push(patch.dueDate == null ? "Due date cleared" : `Due → ${patch.dueDate}`);
  if (patch.recurrence !== undefined) parts.push(`Recurrence → ${patch.recurrence}`);
  if (patch.dependsOn !== undefined) parts.push("Dependencies updated");
  if (patch.customFields !== undefined) parts.push("Custom fields updated");
  if (patch.description !== undefined)
    parts.push(patch.description == null ? "Description cleared" : "Description updated");
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
  // 1. Which ids does the user actually own? (also grabs prior status for logs)
  const owned = ids.length
    ? await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)))
    : [];
  const ownedIds = owned.map((r) => r.id);
  const ownedSet = new Set(ownedIds);
  const skipped = ids.filter((id) => !ownedSet.has(id));
  if (!ownedIds.length) return { updated: 0, skipped, tasks: [] };

  // 2. Build the column patch — same field set + null-clearing as updateTask.
  const now = new Date();
  const values: Record<string, unknown> = { updatedAt: now };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.assignees !== undefined) values.assignees = patch.assignees;
  if (patch.startDate !== undefined) values.startDate = patch.startDate;
  if (patch.dueDate !== undefined) values.dueDate = patch.dueDate;
  if (patch.recurrence !== undefined) values.recurrence = patch.recurrence;
  if (patch.dependsOn !== undefined) values.dependsOn = patch.dependsOn;
  if (patch.customFields !== undefined) values.customFields = patch.customFields;
  if (patch.value !== undefined) values.value = patch.value;
  if (patch.difficulty !== undefined) values.difficulty = patch.difficulty;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.tags !== undefined) values.tags = patch.tags;
  if (patch.status !== undefined) {
    values.status = patch.status;
    values.statusSince = now;
    values.completedAt = patch.status === "done" ? now : null;
  }

  // 3. One UPDATE for the whole owned set.
  const rows = await db
    .update(tasks)
    .set(values)
    .where(and(eq(tasks.userId, userId), inArray(tasks.id, ownedIds)))
    .returning();

  // 4. One batched INSERT into the activity log — a trail row per task.
  const constMsg = describeBulkPatch(patch);
  const priorStatus = new Map(owned.map((r) => [r.id, r.status]));
  const logRows = rows.map((r) => {
    const parts: string[] = [];
    if (patch.status !== undefined && patch.status !== priorStatus.get(r.id))
      parts.push(
        `Status: ${STATUS_LABEL[priorStatus.get(r.id)!]} → ${STATUS_LABEL[patch.status]}`,
      );
    if (constMsg) parts.push(constMsg);
    return {
      taskId: r.id,
      kind: "updated" as const,
      message: parts.length ? parts.join(" · ") : "Updated",
      author,
    };
  });
  if (logRows.length) await db.insert(taskLogs).values(logRows);

  // 5. Shape the refreshed tasks (comment counts, like updateTask).
  const counts = await commentCounts(userId);
  return {
    updated: rows.length,
    skipped,
    tasks: rows.map((r) => rowToTask(r, counts.get(r.id) ?? 0)),
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
      .where(and(eq(taskAttachments.id, attachmentId), eq(tasks.userId, userId)))
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
      .where(and(eq(taskAttachments.id, attachmentId), eq(tasks.userId, userId)))
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
/* Projects & Boards                                                     */
/* -------------------------------------------------------------------- */

const rowToBoard = (r: BoardRow): Board => ({
  id: r.id,
  projectId: r.projectId,
  name: r.name,
});

/** True if the project exists and belongs to the user. */
async function ownsProject(id: string, userId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .limit(1)
  )[0];
  return !!row;
}

/** True if the board exists and belongs to the user. */
async function ownsBoard(id: string, userId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: boards.id })
      .from(boards)
      .where(and(eq(boards.id, id), eq(boards.userId, userId)))
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

/** All of a user's projects, each with its boards nested (position order). */
export async function listProjects(userId: string): Promise<Project[]> {
  const [projectRows, boardRows] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(eq(projects.userId, userId))
      .orderBy(asc(projects.position)),
    db
      .select()
      .from(boards)
      .where(eq(boards.userId, userId))
      .orderBy(asc(boards.position)),
  ]);
  const byProject = new Map<string, Board[]>();
  for (const b of boardRows) {
    const list = byProject.get(b.projectId) ?? [];
    list.push(rowToBoard(b));
    byProject.set(b.projectId, list);
  }
  return projectRows.map((p: ProjectRow) => ({
    id: p.id,
    name: p.name,
    boards: byProject.get(p.id) ?? [],
  }));
}

export async function createProject(
  userId: string,
  name: string,
): Promise<Project> {
  const position = await nextOrdinal(projects, eq(projects.userId, userId));
  const [row] = await db
    .insert(projects)
    .values({ userId, name, position })
    .returning();
  return { id: row.id, name: row.name, boards: [] };
}

export async function updateProject(
  userId: string,
  id: string,
  patch: { name?: string },
): Promise<Project | null> {
  if (!(await ownsProject(id, userId))) return null;
  const [row] = await db
    .update(projects)
    .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), updatedAt: new Date() })
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .returning();
  return row ? { id: row.id, name: row.name } : null;
}

/** Delete a project (cascades to its boards, and their tasks). */
export async function deleteProject(userId: string, id: string): Promise<boolean> {
  const res = await db
    .delete(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .returning();
  return res.length > 0;
}

export async function createBoard(
  userId: string,
  projectId: string,
  name: string,
): Promise<Board | null> {
  if (!(await ownsProject(projectId, userId))) return null;
  const position = await nextOrdinal(
    boards,
    and(eq(boards.userId, userId), eq(boards.projectId, projectId)),
  );
  const [row] = await db
    .insert(boards)
    .values({ userId, projectId, name, position })
    .returning();
  return rowToBoard(row);
}

export async function updateBoard(
  userId: string,
  id: string,
  patch: { name?: string },
): Promise<Board | null> {
  const [row] = await db
    .update(boards)
    .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), updatedAt: new Date() })
    .where(and(eq(boards.id, id), eq(boards.userId, userId)))
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
        .where(
          and(
            eq(boards.id, id),
            eq(boards.userId, userId),
            eq(boards.projectId, projectId),
          ),
        ),
    ),
  );
  return true;
}

/** Delete a board (cascades to its tasks + their logs). */
export async function deleteBoard(userId: string, id: string): Promise<boolean> {
  const res = await db
    .delete(boards)
    .where(and(eq(boards.id, id), eq(boards.userId, userId)))
    .returning();
  return res.length > 0;
}

/* -------------------------------------------------------------------- */
/* AI-readable Markdown rendering                                        */
/* -------------------------------------------------------------------- */

/** Render the whole board as compact Markdown — great for an AI to skim. */
export function toMarkdown(tree: TaskDTO[]): string {
  const order: TaskStatus[] = ["in-progress", "planned", "backlog", "done"];
  const lines: string[] = ["# Tasks", ""];
  for (const status of order) {
    const group = tree.filter((t) => t.status === status);
    if (!group.length) continue;
    lines.push(`## ${STATUS_LABEL[status]}`, "");
    for (const t of group) lines.push(...taskLines(t, 0));
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

function taskLines(t: TaskDTO, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const box = t.status === "done" ? "[x]" : "[ ]";
  const meta: string[] = [];
  if (t.value != null) meta.push(`value:${t.value}`);
  if (t.difficulty != null) meta.push(`diff:${t.difficulty}`);
  if (t.assignees?.length) meta.push(...t.assignees.map((a) => `@${a}`));
  if (t.startDate) meta.push(`start:${t.startDate}`);
  if (t.dueDate) meta.push(`due:${t.dueDate}`);
  if (t.recurrence && t.recurrence !== "none") meta.push(`↻${t.recurrence}`);
  if (t.dependsOn?.length) meta.push(`⛔${t.dependsOn.length}`);
  if (t.tags?.length) meta.push(...t.tags.map((x) => `#${x}`));
  if (t.attachments?.length) meta.push(`📎${t.attachments.length}`);
  const tail = meta.length ? `  _(${meta.join(" · ")})_` : "";
  const lines = [`${pad}- ${box} **${t.title}** \`${t.id}\`${tail}`];
  if (t.description) lines.push(`${pad}  ${t.description}`);
  for (const s of t.subtasks ?? []) lines.push(...taskLines(s, depth + 1));
  return lines;
}
