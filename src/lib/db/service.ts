/*
  ====================================================================
  TASK SERVICE — the one place task logic lives.
  The web UI (via /api/tasks), the REST API, and the MCP server all
  call THESE functions. One code path for humans and AI => no drift.
  Returns the app's `Task` shape (see ../types.ts) so screens and AIs
  get the same clean, self-describing objects.
  ====================================================================
*/

import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { del } from "@vercel/blob";
import { blobAuth } from "@/lib/blob";
import { db } from "./client";
import {
  tasks,
  taskLogs,
  taskAttachments,
  taskDecisions,
  taskNotes,
  taskCommits,
  projects,
  boards,
  users,
  type TaskRow,
  type TaskAttachmentRow,
  type TaskDecisionRow,
  type TaskNoteRow,
  type TaskCommitRow,
  type ProjectRow,
  type BoardRow,
} from "./schema";
import { STATUS_LABEL } from "@/lib/statuses";
import { ConflictError } from "@/lib/api";
import { daysAgo } from "@/lib/format";
import { deriveCode, sanitizeCode, formatCode } from "@/lib/refs";
import type {
  Task,
  TaskStatus,
  TaskPhase,
  Recurrence,
  FibPoints,
  CustomFieldValue,
  TaskLogEntry,
  Attachment,
  Project,
  Board,
  Decision,
  DecisionCategory,
  DecisionOutcome,
  Note,
  NoteType,
  TaskCommit,
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

/* -------------------------------------------------------------------- */
/* Codes / refs                                                          */
/* -------------------------------------------------------------------- */

/** Preloaded owner codes, so a list of tasks renders soft codes with no N+1. */
interface CodeCtx {
  board: Map<string, string | null>;
  project: Map<string, string | null>;
  userCode: string | null;
}

/** Load every code a user owns (board/project/user) in one shot. */
async function codeCtx(userId: string): Promise<CodeCtx> {
  const [boardRows, projectRows, userRows] = await Promise.all([
    db.select({ id: boards.id, code: boards.code }).from(boards).where(eq(boards.userId, userId)),
    db.select({ id: projects.id, code: projects.code }).from(projects).where(eq(projects.userId, userId)),
    db.select({ code: users.code }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  return {
    board: new Map(boardRows.map((r) => [r.id, r.code])),
    project: new Map(projectRows.map((r) => [r.id, r.code])),
    userCode: userRows[0]?.code ?? null,
  };
}

/** Resolve the current prefix for a task (board → project → user). */
function resolvePrefix(row: TaskRow, ctx?: CodeCtx): string | null {
  if (!ctx) return null;
  const fromBoard = row.boardId ? ctx.board.get(row.boardId) : null;
  if (fromBoard) return fromBoard;
  const fromProject = row.projectId ? ctx.project.get(row.projectId) : null;
  if (fromProject) return fromProject;
  return ctx.userCode ?? null;
}

/** The displayed code: the frozen `ref` when locked, else a soft `PREFIX-seq*`. */
function displayCode(row: TaskRow, ctx?: CodeCtx): string | undefined {
  if (row.refLocked && row.ref) return row.ref;
  if (row.seq == null) return undefined;
  const prefix = resolvePrefix(row, ctx);
  if (!prefix) return undefined;
  return formatCode(prefix, row.seq, false);
}

/** Derive the workflow phase from lifecycle timestamps + lock state. */
function derivePhase(row: TaskRow): TaskPhase {
  if (row.completedAt) return "done";
  if (row.workStartedAt) return "working";
  if (row.analyzedAt) return "analyzed";
  if (row.analysisStartedAt) return "analyzing";
  if (row.refLocked) return "ready";
  return "draft";
}

function rowToTask(
  row: TaskRow,
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
    phase: derivePhase(row),
    analysisStartedAt: iso(row.analysisStartedAt) ?? null,
    analyzedAt: iso(row.analyzedAt) ?? null,
    workStartedAt: iso(row.workStartedAt) ?? null,
    analysisSummary: row.analysisSummary,
    plan: row.plan,
    summary: row.summary,
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
    projectId: row.projectId,
    parentId: row.parentId,
    position: row.position,
    statusSince: iso(row.statusSince)!,
    completedAt: iso(row.completedAt),
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

/** Current ref owner for a task (board → project → user). */
function ownerOf(
  row: { boardId: string | null; projectId: string | null },
  userId: string,
): { scope: "board" | "project" | "user"; id: string } {
  if (row.boardId) return { scope: "board", id: row.boardId };
  if (row.projectId) return { scope: "project", id: row.projectId };
  return { scope: "user", id: userId };
}

/** Every code a user owns — used to keep prefixes unique across their world. */
async function existingCodes(userId: string): Promise<Set<string>> {
  const ctx = await codeCtx(userId);
  const set = new Set<string>();
  for (const c of ctx.board.values()) if (c) set.add(c.toUpperCase());
  for (const c of ctx.project.values()) if (c) set.add(c.toUpperCase());
  if (ctx.userCode) set.add(ctx.userCode.toUpperCase());
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

/**
 * Lock a task's code (idempotent). Freezes the current soft code into `ref`.
 * Triggered on handoff (work_on_task / Copy prompt) or as a backstop on the
 * first real mutation, so a "real" task never lacks a locked code.
 */
export async function mintRef(id: string, userId: string): Promise<TaskDTO | null> {
  const current = (
    await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
  )[0];
  if (!current) return null;
  const ctx = await codeCtx(userId);
  if (current.refLocked && current.ref) return rowToTask(current, 0, [], ctx);

  // Ensure the owner has a code (derive + persist if missing).
  const owner = ownerOf(current, userId);
  let prefix = resolvePrefix(current, ctx);
  if (!prefix) {
    prefix = await ensureOwnerCode(owner, userId);
  }
  const seq = current.seq ?? (await allocSeq(owner.scope, owner.id));
  const refStr = `${prefix}-${seq}`;
  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set({ ref: refStr, refLocked: true, lockedAt: now, seq, updatedAt: now })
    .where(and(eq(tasks.id, id), eq(tasks.refLocked, false)))
    .returning();
  if (!row) {
    // Locked concurrently — return the fresh row.
    const fresh = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
    return fresh ? rowToTask(fresh, 0, [], ctx) : null;
  }
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

/* ---- Row → DTO converters for decisions / notes / commits ---- */

const rowToDecision = (r: TaskDecisionRow): Decision => ({
  id: r.id,
  taskId: r.taskId,
  category: r.category,
  decision: r.decision,
  rationale: r.rationale,
  phase: r.phase,
  author: r.author,
  createdAt: iso(r.createdAt)!,
  outcome: r.outcome,
  reviewedAt: iso(r.reviewedAt) ?? null,
  reviewNote: r.reviewNote,
  supersededById: r.supersededById,
});

const rowToNote = (r: TaskNoteRow): Note => ({
  id: r.id,
  taskId: r.taskId,
  type: r.type,
  note: r.note,
  author: r.author,
  createdAt: iso(r.createdAt)!,
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
  rows: TaskRow[],
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
  /** Only tasks carrying this tag. */
  tag?: string;
  /** Case-insensitive substring match on title or description. */
  text?: string;
  /** Only tasks due on/before this date (YYYY-MM-DD). */
  dueBefore?: string;
  /** Only tasks due on/after this date (YYYY-MM-DD). */
  dueAfter?: string;
  /** Only tasks past due and not done. */
  overdue?: boolean;
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
  if (filter?.status?.length) conds.push(inArray(tasks.status, filter.status));
  // Array-membership: assignees/tags are text[] columns.
  if (filter?.assignee)
    conds.push(sql`${filter.assignee} = ANY(${tasks.assignees})`);
  if (filter?.tag) conds.push(sql`${filter.tag} = ANY(${tasks.tags})`);
  if (filter?.text) {
    const pat = `%${filter.text}%`;
    conds.push(
      or(ilike(tasks.title, pat), ilike(sql`coalesce(${tasks.description}, '')`, pat)),
    );
  }
  if (filter?.dueBefore) conds.push(sql`${tasks.dueDate} <= ${filter.dueBefore}`);
  if (filter?.dueAfter) conds.push(sql`${tasks.dueDate} >= ${filter.dueAfter}`);
  if (filter?.overdue) {
    // CURRENT_DATE is the server's date (UTC on Vercel) — fine for a personal board.
    conds.push(sql`${tasks.dueDate} < CURRENT_DATE`);
    conds.push(sql`${tasks.status} <> 'done'`);
  }
  return and(...conds);
}

/** All of a user's tasks as a nested tree, ordered by status then position. */
export async function listTasks(
  userId: string,
  filter?: TaskFilter,
): Promise<TaskDTO[]> {
  const [rows, counts, attachments, ctx] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(taskWhere(userId, filter))
      .orderBy(asc(tasks.position)),
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
    db
      .select()
      .from(tasks)
      .where(taskWhere(userId, filter))
      .orderBy(asc(tasks.position)),
    commentCounts(userId),
    attachmentsByTask(userId),
    codeCtx(userId),
  ]);
  return rows.map((r) =>
    rowToTask(r, counts.get(r.id) ?? 0, attachments.get(r.id), ctx),
  );
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
    if (t.status === "in-progress" || t.status === "planned") return true;
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
      .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)))
      .orderBy(asc(tasks.position)),
    commentCounts(userId),
    codeCtx(userId),
  ]);
  return rows.map((r) => rowToTask(r, counts.get(r.id) ?? 0, undefined, ctx));
}

export async function getTask(
  id: string,
  userId: string,
): Promise<{
  task: TaskDTO;
  logs: TaskLogEntry[];
  decisions: Decision[];
  notes: Note[];
  commits: TaskCommit[];
} | null> {
  const row = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
  )[0];
  if (!row) return null;
  const [logRows, attachmentRows, decisionRows, noteRows, commitRows, ctx] =
    await Promise.all([
      db.select().from(taskLogs).where(eq(taskLogs.taskId, id)).orderBy(asc(taskLogs.at)),
      db.select().from(taskAttachments).where(eq(taskAttachments.taskId, id)).orderBy(asc(taskAttachments.createdAt)),
      db.select().from(taskDecisions).where(eq(taskDecisions.taskId, id)).orderBy(asc(taskDecisions.createdAt)),
      db.select().from(taskNotes).where(eq(taskNotes.taskId, id)).orderBy(asc(taskNotes.createdAt)),
      db.select().from(taskCommits).where(eq(taskCommits.taskId, id)).orderBy(asc(taskCommits.createdAt)),
      codeCtx(userId),
    ]);
  const cCount = logRows.filter((l) => l.kind === "comment").length;
  return {
    task: rowToTask(row, cCount, attachmentRows.map(rowToAttachment), ctx),
    logs: logRows.map((l) => ({
      id: l.id,
      at: iso(l.at)!,
      kind: l.kind,
      message: l.message,
      author: l.author ?? undefined,
    })),
    decisions: decisionRows.map(rowToDecision),
    notes: noteRows.map(rowToNote),
    commits: commitRows.map(rowToCommit),
  };
}

type TaskContext = Awaited<ReturnType<typeof getTask>>;

/**
 * Enter the ANALYSIS phase — the required entry point before analysing a task.
 * Locks the code (so commits can cite it), stamps `analysisStartedAt` the FIRST
 * time only (set-if-null), leaves an attributed `started` activity row, and
 * returns the full task context. Idempotent: a second call just returns the
 * context without re-stamping or re-logging. This is what binds "started
 * analysing" to the act of fetching what you need to analyse — you can't get
 * the context without recording the start.
 */
export async function startAnalysis(
  id: string,
  userId: string,
  author = "You",
): Promise<TaskContext> {
  const locked = await mintRef(id, userId);
  if (!locked) return null;
  const current = (
    await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
  )[0];
  if (current && !current.analysisStartedAt) {
    const now = new Date();
    await db.update(tasks).set({ analysisStartedAt: now, updatedAt: now }).where(eq(tasks.id, id));
    await log(id, "started", "Analysis started", author);
  }
  return getTask(id, userId);
}

/**
 * Enter the WORK phase — the required entry point before building a task.
 * Stamps `workStartedAt` the FIRST time only (set-if-null), leaves an attributed
 * `started` activity row, and returns the full working context. Idempotent.
 * Same principle as {@link startAnalysis}: fetching the build context is what
 * records that work began — no separate "remember to mark it" step, and no
 * reliance on the first commit (which lands late).
 */
export async function startWork(
  id: string,
  userId: string,
  author = "You",
): Promise<TaskContext> {
  const current = (
    await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
  )[0];
  if (!current) return null;
  if (!current.workStartedAt) {
    const now = new Date();
    await db.update(tasks).set({ workStartedAt: now, updatedAt: now }).where(eq(tasks.id, id));
    await log(id, "started", "Work started", author);
  }
  return getTask(id, userId);
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
  const board =
    input.boardId != null
      ? (
          await db
            .select({ id: boards.id, projectId: boards.projectId })
            .from(boards)
            .where(and(eq(boards.id, input.boardId), eq(boards.userId, userId)))
            .limit(1)
        )[0]
      : undefined;
  const boardId = board?.id ?? null;
  // A task scoped to a board inherits its project (so a code prefix falls back
  // board → project → user). Board-less tasks are user-scoped for now.
  const projectId = board?.projectId ?? null;
  const position = await nextPosition(userId, status, parentId);
  // Draw a soft number from the current owner (board → project → user). The
  // code stays unlocked (soft, shows a trailing "*") until handoff / mint.
  const owner = ownerOf({ boardId, projectId }, userId);
  const seq = await allocSeq(owner.scope, owner.id);
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
      projectId,
      seq,
      position,
      completedAt: status === "done" ? new Date() : null,
    })
    .returning();
  await log(row.id, "created", `Created in ${STATUS_LABEL[status]}`, author);
  return rowToTask(row, 0, [], await codeCtx(userId));
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
  /* ---- Workflow: revisable summaries (null clears) ---- */
  analysisSummary?: string | null;
  plan?: string | null;
  summary?: string | null;
  /* ---- Workflow: lifecycle timestamps (ISO string, or null to clear) ---- */
  analysisStartedAt?: string | null;
  analyzedAt?: string | null;
  workStartedAt?: string | null;
}

/** Parse an ISO string (or null) into a Date for a timestamp column. */
const toDate = (v: string | null | undefined): Date | null | undefined =>
  v === undefined ? undefined : v === null ? null : new Date(v);

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
  if (patch.analysisSummary !== undefined) values.analysisSummary = patch.analysisSummary;
  if (patch.plan !== undefined) values.plan = patch.plan;
  if (patch.summary !== undefined) values.summary = patch.summary;
  if (patch.analysisStartedAt !== undefined) values.analysisStartedAt = toDate(patch.analysisStartedAt);
  if (patch.analyzedAt !== undefined) values.analyzedAt = toDate(patch.analyzedAt);
  if (patch.workStartedAt !== undefined) values.workStartedAt = toDate(patch.workStartedAt);

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
  const [counts, ctx] = await Promise.all([commentCounts(userId), codeCtx(userId)]);
  return rowToTask(row, counts.get(id) ?? 0, undefined, ctx);
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
  const newOwner = ownerOf({ boardId, projectId }, userId);
  if (
    !current.refLocked &&
    (oldOwner.scope !== newOwner.scope || oldOwner.id !== newOwner.id)
  ) {
    seq = await allocSeq(newOwner.scope, newOwner.id);
  }

  const [row] = await db
    .update(tasks)
    .set({
      status,
      parentId,
      boardId,
      projectId,
      seq,
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
  const [counts, ctx] = await Promise.all([commentCounts(userId), codeCtx(userId)]);
  return rowToTask(row, counts.get(id) ?? 0, undefined, ctx);
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
/* Decisions                                                             */
/* -------------------------------------------------------------------- */

export interface RecordDecisionInput {
  category: DecisionCategory;
  decision: string;
  rationale?: string | null;
}

/**
 * Record a decision on a task and AUTO-FIRE the lifecycle: the first decision
 * stamps `analysisStartedAt` (the first sign real analysis is underway). The
 * decision's phase is derived from whether work has started yet.
 */
export async function recordDecision(
  taskId: string,
  input: RecordDecisionInput,
  userId: string,
  author = "You",
): Promise<Decision | null> {
  const task = (
    await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
  )[0];
  if (!task) return null;

  const phase = task.workStartedAt ? "execution" : "analysis";
  const [row] = await db
    .insert(taskDecisions)
    .values({
      taskId,
      userId,
      category: input.category,
      decision: input.decision,
      rationale: input.rationale ?? null,
      phase,
      author,
    })
    .returning();

  // Auto-fire: first decision during analysis starts the analysis clock.
  const stamp: Record<string, unknown> = { updatedAt: new Date() };
  if (phase === "analysis" && !task.analysisStartedAt)
    stamp.analysisStartedAt = new Date();
  await db.update(tasks).set(stamp).where(eq(tasks.id, taskId));

  return rowToDecision(row);
}

/** Filters for querying decisions across all of a user's tasks. */
export interface DecisionFilter {
  taskId?: string;
  category?: DecisionCategory;
  boardId?: string;
  projectId?: string;
  /** Only decisions still awaiting a retro verdict. */
  unreviewed?: boolean;
  from?: string; // ISO/date lower bound (inclusive)
  to?: string; // ISO/date upper bound (inclusive)
}

/** Query a user's decisions across tasks — powers the Decisions page + retro. */
export async function listDecisions(
  userId: string,
  filter?: DecisionFilter,
): Promise<Decision[]> {
  const conds: (SQL | undefined)[] = [eq(taskDecisions.userId, userId)];
  if (filter?.taskId) conds.push(eq(taskDecisions.taskId, filter.taskId));
  if (filter?.category) conds.push(eq(taskDecisions.category, filter.category));
  if (filter?.unreviewed) conds.push(sql`${taskDecisions.outcome} is null`);
  if (filter?.from) conds.push(gte(taskDecisions.createdAt, new Date(filter.from)));
  if (filter?.to) conds.push(lte(taskDecisions.createdAt, new Date(filter.to)));
  if (filter?.boardId || filter?.projectId) {
    const taskConds: SQL[] = [eq(tasks.userId, userId)];
    if (filter.boardId) taskConds.push(eq(tasks.boardId, filter.boardId));
    if (filter.projectId) taskConds.push(eq(tasks.projectId, filter.projectId));
    conds.push(
      inArray(
        taskDecisions.taskId,
        db.select({ id: tasks.id }).from(tasks).where(and(...taskConds)),
      ),
    );
  }
  const rows = await db
    .select()
    .from(taskDecisions)
    .where(and(...conds))
    .orderBy(desc(taskDecisions.createdAt));
  return rows.map(rowToDecision);
}

export interface ReviewDecisionInput {
  outcome: DecisionOutcome;
  reviewNote?: string | null;
}

/** Fill in a decision's retro verdict (was it good?). */
export async function reviewDecision(
  id: string,
  input: ReviewDecisionInput,
  userId: string,
): Promise<Decision | null> {
  const [row] = await db
    .update(taskDecisions)
    .set({
      outcome: input.outcome,
      reviewNote: input.reviewNote ?? null,
      reviewedAt: new Date(),
    })
    .where(and(eq(taskDecisions.id, id), eq(taskDecisions.userId, userId)))
    .returning();
  return row ? rowToDecision(row) : null;
}

/* -------------------------------------------------------------------- */
/* Notes (standup material)                                              */
/* -------------------------------------------------------------------- */

export interface AddNoteInput {
  note: string;
  type?: NoteType | null;
}

/** Add a team-facing note to a task (raw material for the standup digest). */
export async function addNote(
  taskId: string,
  input: AddNoteInput,
  userId: string,
  author = "You",
): Promise<Note | null> {
  if (!(await ownsTask(taskId, userId))) return null;
  const [row] = await db
    .insert(taskNotes)
    .values({ taskId, userId, note: input.note, type: input.type ?? null, author })
    .returning();
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  return rowToNote(row);
}

export interface NoteFilter {
  taskId?: string;
  type?: NoteType;
  from?: string;
  to?: string;
}

/** Query a user's notes across tasks — powers the Notes page + standup. */
export async function listNotes(
  userId: string,
  filter?: NoteFilter,
): Promise<Note[]> {
  const conds: (SQL | undefined)[] = [eq(taskNotes.userId, userId)];
  if (filter?.taskId) conds.push(eq(taskNotes.taskId, filter.taskId));
  if (filter?.type) conds.push(eq(taskNotes.type, filter.type));
  if (filter?.from) conds.push(gte(taskNotes.createdAt, new Date(filter.from)));
  if (filter?.to) conds.push(lte(taskNotes.createdAt, new Date(filter.to)));
  const rows = await db
    .select()
    .from(taskNotes)
    .where(and(...conds))
    .orderBy(desc(taskNotes.createdAt));
  return rows.map(rowToNote);
}

/* -------------------------------------------------------------------- */
/* Commits                                                               */
/* -------------------------------------------------------------------- */

/**
 * Link a git commit back to a task, and AUTO-FIRE `workStartedAt` (the first
 * commit is the first sign execution is underway). Idempotent per (task, sha).
 */
export async function linkCommit(
  taskId: string,
  sha: string,
  subject: string | null,
  userId: string,
): Promise<TaskCommit | null> {
  const task = (
    await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
  )[0];
  if (!task) return null;
  const [row] = await db
    .insert(taskCommits)
    .values({ taskId, userId, sha, subject })
    .onConflictDoNothing({ target: [taskCommits.taskId, taskCommits.sha] })
    .returning();

  const stamp: Record<string, unknown> = { updatedAt: new Date() };
  if (!task.workStartedAt) stamp.workStartedAt = new Date();
  await db.update(tasks).set(stamp).where(eq(tasks.id, taskId));

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

/** Everything the standup prompt/view needs for a date window, in one call. */
export interface StandupData {
  notes: Note[];
  finished: TaskDTO[];
  decisions: Decision[];
}

export async function standup(
  userId: string,
  from: string,
  to: string,
): Promise<StandupData> {
  const [notes, decisions, ctx, finishedRows] = await Promise.all([
    listNotes(userId, { from, to }),
    listDecisions(userId, { from, to }),
    codeCtx(userId),
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.status, "done"),
          gte(tasks.completedAt, new Date(from)),
          lte(tasks.completedAt, new Date(to)),
        ),
      )
      .orderBy(desc(tasks.completedAt)),
  ]);
  return {
    notes,
    decisions,
    finished: finishedRows.map((r) => rowToTask(r, 0, [], ctx)),
  };
}

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

/** One board by id, scoped to the user (null if not found / not theirs). */
export async function getBoard(
  userId: string,
  id: string,
): Promise<Board | null> {
  const row = (
    await db
      .select()
      .from(boards)
      .where(and(eq(boards.id, id), eq(boards.userId, userId)))
      .limit(1)
  )[0];
  return row ? rowToBoard(row) : null;
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
    ...rowToProject(p),
    boards: byProject.get(p.id) ?? [],
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
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
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
  } = {},
): Promise<Project> {
  const position = await nextOrdinal(projects, eq(projects.userId, userId));
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
  return { ...rowToProject(row), boards: [] };
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
  },
): Promise<Project | null> {
  const cur = (
    await db
      .select({ code: projects.code })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
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
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .returning();
  return row ? rowToProject(row) : null;
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
  opts: {
    code?: string;
    color?: string;
    image?: string | null;
    gitFolder?: string | null;
    description?: string | null;
  } = {},
): Promise<Board | null> {
  if (!(await ownsProject(projectId, userId))) return null;
  const position = await nextOrdinal(
    boards,
    and(eq(boards.userId, userId), eq(boards.projectId, projectId)),
  );
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
      .where(and(eq(boards.id, id), eq(boards.userId, userId)))
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
  if (t.phase && t.phase !== "draft" && t.phase !== "done") meta.push(`phase:${t.phase}`);
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
  // Show the human code up front; keep the raw id (in backticks) for tools.
  const codeTag = t.code ? `\`${t.code}\` ` : "";
  const lines = [`${pad}- ${box} ${codeTag}**${t.title}** \`${t.id}\`${tail}`];
  if (t.description) lines.push(`${pad}  ${t.description}`);
  for (const s of t.subtasks ?? []) lines.push(...taskLines(s, depth + 1));
  return lines;
}
