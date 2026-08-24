/*
  ====================================================================
  MCP SERVER — the direct link for Claude Code (and any MCP client).
  Exposes the task board as tools over the Model Context Protocol
  (Streamable HTTP). Same service layer as the REST API + web UI, so
  an AI edit and a human edit go through the exact same door.

  Auth is a PER-USER bearer token (create one on the Connect page in the
  web app). The token identifies the user, so a user's Claude only ever
  sees and edits THAT user's tasks. Add it in Claude Code:
    claude mcp add --transport http todo \
      https://to-do-challenger.vercel.app/api/mcp \
      --header "Authorization: Bearer <your-personal-token>"
  ====================================================================
*/

import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler } from "mcp-handler";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireUser, AuthError } from "@/lib/auth";
import { withLogContext } from "@/lib/db/log-context";
import {
  ConflictError,
  bulkOpSchema,
  updateTaskSchema,
  taskFilterShape,
  taskDetailSchema,
} from "@/lib/api";
import { daysAgo } from "@/lib/format";
import {
  listTasks,
  listTasksFlat,
  listToday,
  searchTasks,
  countTasks,
  activityDigest,
  workDayReview,
  boardReview,
  markDayReady,
  finishWork,
  logPastWork,
  TASK_FILTER_KEYS,
  getTask,
  createTask,
  updateTask,
  moveTask,
  completeTask,
  archiveTask,
  addComment,
  deleteTask,
  purgeTask,
  restoreTask,
  bulkUpdate,
  bulkApply,
  getAttachmentById,
  toMarkdown,
  userNameMap,
  resolveAssignees,
  listProjects,
  createProject,
  updateProject,
  addProjectMember,
  removeProjectMember,
  createBoard,
  updateBoard,
  mintRef,
  linkCommit,
  listCanvases,
  getCanvas,
  createCanvas,
  type TaskDTO,
} from "@/lib/db/service";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  CalendarError,
} from "@/lib/google/calendar";
import { listUsers, getUserById, type PublicUser } from "@/lib/db/users";
import { listPublicConnections } from "@/lib/google/connections";
import { SYNC_NOTE } from "@/lib/repo-sync";
import { WORKFLOW, DAY_CLOSE, BOARD_CLEANUP } from "@/lib/workflow";
import { langSuffix, titleHeader } from "@/lib/prompts";
import { capped, type CapOpts } from "@/lib/mcp-response";

export const runtime = "nodejs";
export const maxDuration = 60;

/*
  The MCP handler + its tools are built once, but WHICH user a request
  belongs to is per-request (resolved from the bearer token). We stash
  the user id in AsyncLocalStorage for the duration of each request so
  the tool callbacks can scope every DB call to that user's own tasks.
*/
const userStore = new AsyncLocalStorage<string>();
const currentUser = (): string => {
  const uid = userStore.getStore();
  if (!uid) throw new AuthError("No authenticated user in this request.");
  return uid;
};

const statusEnum = z.enum([
  "backlog",
  "todo",
  "analyzing",
  "analyzed",
  "building",
  "review",
  "done",
]);
const recurrenceEnum = z.enum(["none", "daily", "weekly", "monthly"]);
/** Which canvas group a task is filed in — its triage bucket, independent of
 *  status. Mirrors `placementSchema` in api.ts. */
const placementEnum = z.enum([
  "inbox",
  "thisWeek",
  "backlog",
  "later",
  "doneThisWeek",
]);
/** Fibonacci points for value (payoff) and difficulty (effort). */
const fibEnum = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
]);
/** Importance/priority ladder: 2 High, 1 Elevated, 0 Normal (default), -1 Low. */
const importanceArg = z
  .number()
  .int()
  .min(-1)
  .max(2)
  .describe(
    "Importance/priority: 2 High · 1 Elevated · 0 Normal (default) · -1 Low. Most tasks stay 0.",
  ) as z.ZodType<-1 | 0 | 1 | 2>;
const assigneeIdsArg = z
  .array(z.string().max(120))
  .max(20)
  .describe(
    "People assigned, each a user id, email, or display name (resolved to accounts server-side — see list_users). Empty array clears.",
  );
const dependsOnArg = z.array(z.string()).max(50);
const customFieldsArg = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
/**
 * How you point at a task: its UUID, OR its human code — the short handle
 * people actually share (e.g. "PLAT-77"). Both forms resolve to the same task.
 */
const taskHandle = z
  .string()
  .describe(
    'A task handle: either its UUID or its human code — the short ref people ' +
      'share, like "PLAT-77" (a locked code) or "PLAT-77*" (a soft/unlocked ' +
      "code; the trailing * is optional). Both forms resolve to the same task.",
  );
/** MCP-authored changes are attributed to "Claude" in the activity log. */
const AI_AUTHOR = "Claude";

/** Resolve loose member identifiers (user id, email, or display name) against
 *  the roster → { ids, unresolved }. Case-insensitive on email/name. Used by
 *  the project-member tools so an AI can add "Simon" without knowing the id. */
async function resolveMemberIdentifiers(
  identifiers: string[],
): Promise<{ ids: string[]; unresolved: string[] }> {
  const roster = await listUsers();
  const byId = new Map(roster.map((u) => [u.id, u]));
  const byEmail = new Map(roster.map((u) => [u.email.trim().toLowerCase(), u]));
  const byName = new Map(roster.map((u) => [u.name.trim().toLowerCase(), u]));
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const raw of identifiers) {
    const key = raw.trim().toLowerCase();
    const hit = byId.get(raw) ?? byEmail.get(key) ?? byName.get(key);
    if (hit) ids.push(hit.id);
    else unresolved.push(raw);
  }
  return { ids: [...new Set(ids)], unresolved };
}

/** Map member user ids → readable {id, name, email} using the roster (drops
 *  any id no longer in the roster). For human-friendly MCP output. */
function membersToPublic(
  ids: string[],
  roster: PublicUser[],
): { id: string; name: string; email: string }[] {
  const byId = new Map(roster.map((u) => [u.id, u]));
  return ids
    .map((id) => byId.get(id))
    .filter((u): u is PublicUser => !!u)
    .map((u) => ({ id: u.id, name: u.name, email: u.email }));
}

/**
 * Every tool result goes out through here, so the response budget
 * (`@/lib/mcp-response`) is enforced in exactly one place — including for
 * tools added later, which is the point.
 */
const text = (data: unknown, opts?: CapOpts) => ({
  content: [{ type: "text" as const, text: capped(data, opts) }],
});

/** No real account resolves to this, so an unresolvable name filters to
 *  nothing rather than silently matching everyone. */
const NO_SUCH_USER = "__no_such_user__";

/** Resolve the human-shaped fields of a task filter to account ids: `assignee`
 *  (who it's for) and `actor` (who touched it) both accept an id, email or
 *  display name, plus "me" for the calling user. */
async function resolveFilter<T extends { assignee?: string; actor?: string }>(
  filter: T,
): Promise<T> {
  const out = { ...filter };
  const resolve = async (token: string) =>
    /^(me|myself|self)$/i.test(token.trim())
      ? currentUser()
      : (await resolveAssignees([token]))[0] ?? NO_SUCH_USER;
  if (out.assignee) out.assignee = await resolve(out.assignee);
  if (out.actor) out.actor = await resolve(out.actor);
  return out;
}

/** Tasks in a payload, counting nested subtasks — `rows.length` alone counts
 *  only roots, which would under-report a tree read. */
const countNodes = (ts: TaskDTO[]): number =>
  ts.reduce((n, t) => n + 1 + countNodes(t.subtasks ?? []), 0);

/**
 * How much of each task a multi-task listing returns.
 *
 * - `compact` (the default) — what you need to FIND a task and see where it
 *   stands. No description, no timestamp noise: those are what make a
 *   whole-board read too big to send.
 * - `standard` — everything except the free-text working fields.
 * - `full` — those three fields too. Rarely right: they carry file paths and
 *   code detail for how ANOTHER task was built, and an AI must never infer
 *   where code lives from them. Read the code directly, or `get_task` the one
 *   task you actually care about.
 */
type TaskDetail = "compact" | "standard" | "full";

/** Fields kept at `compact`. Everything else is dropped. */
const COMPACT_FIELDS = [
  "id",
  "code",
  "ref",
  "title",
  "status",
  "statusSince",
  "assigneeIds",
  "boardId",
  "projectId",
  "parentId",
  "dueDate",
  "startDate",
  "value",
  "difficulty",
  "importance",
  "completedAt",
  "archivedAt",
  "deletedAt",
  "dependsOn",
] as const;

function projectTask(t: TaskDTO, detail: TaskDetail): TaskDTO {
  let out: TaskDTO;
  if (detail === "compact") {
    const src = t as unknown as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of COMPACT_FIELDS) {
      const v = src[k];
      // Drop nulls and empty arrays: on a compact read they're pure overhead.
      if (v != null && !(Array.isArray(v) && v.length === 0)) picked[k] = v;
    }
    out = picked as unknown as TaskDTO;
  } else {
    out = { ...t };
    if (detail === "standard") {
      delete out.analysisSummary;
      delete out.plan;
      delete out.summary;
    }
  }
  if (t.subtasks?.length)
    out.subtasks = t.subtasks.map((s) => projectTask(s, detail));
  return out;
}

/** An image content block (base64) — how an AI actually "sees" an attachment. */
const image = (data: string, mimeType: string) => ({
  content: [{ type: "image" as const, data, mimeType }],
});

/* Resource read-result builders (contents[]) and a prompt-message builder. */
const md = (uri: string, body: string) => ({
  contents: [{ uri, mimeType: "text/markdown", text: body }],
});
const json = (uri: string, data: unknown) => ({
  contents: [
    { uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) },
  ],
});
/** A prompt result: a single pre-filled user message. */
const userMsg = (body: string) => ({
  messages: [
    { role: "user" as const, content: { type: "text" as const, text: body } },
  ],
});

/** Like `userMsg`, but appends the English directive for non-French users so
 *  every slash-command prompt respects the caller's language setting. */
const promptMsg = async (body: string) => {
  const u = await getUserById(currentUser());
  return userMsg(body + langSuffix(u?.language));
};

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "list_tasks",
      "Read tasks — FILTER FIRST, never download the board. Every filter is optional and they AND together; `detail` controls how much of each task comes back and `limit` caps the rows.\n" +
        "\n" +
        "Activity windows answer the questions that used to need the whole board: `statusChangedFrom`/`To` = what MOVED in a date range, `completedFrom`/`To` = what shipped, `updatedFrom`/`To` = what was touched. A bare YYYY-MM-DD means that whole day, and from = to is a legitimate single-day window. `actor` narrows to who actually DID the work (the activity log), which is what \"what did I do today\" means — not `assignee`, which is who it's for.\n" +
        "\n" +
        "Defaults: done tasks are hidden (`includeDone: true` to see them), archived excluded, `detail: 'compact'`, nested tree. `detail: 'standard'` adds descriptions and the rest of the metadata; `detail: 'full'` also returns the free-text working fields (analysisSummary/plan/summary) — rarely right, and NEVER a source for where code lives: those describe how another task was built, so read the code directly or `get_task` the one task you care about. Use format:'markdown' for a skimmable board.",
      {
        ...taskFilterShape,
        includeDone: z
          .boolean()
          .optional()
          .default(false)
          .describe("include done tasks (hidden by default — ask for them)"),
        detail: taskDetailSchema.optional().default("compact"),
        shape: z
          .enum(["tree", "flat"])
          .optional()
          .default("tree")
          .describe("`tree` nests subtasks; `flat` is one row per task"),
        format: z.enum(["json", "markdown"]).optional().default("json"),
      },
      async ({ format, detail, shape, ...filter }) => {
        // Only `detail:'full'` renders the working fields, so only it pays to
        // fetch them (PLAT-403) — every other read leaves them in Postgres.
        const f = { ...(await resolveFilter(filter)), includeWorkingFields: detail === "full" };
        const [rows, total] = await Promise.all([
          shape === "flat"
            ? listTasksFlat(currentUser(), f)
            : listTasks(currentUser(), f),
          countTasks(currentUser(), f),
        ]);
        if (format === "markdown")
          return text(toMarkdown(rows, await userNameMap()));
        return text(
          {
            count: countNodes(rows),
            total,
            tasks: rows.map((t) => projectTask(t, detail)),
          },
          { items: "tasks", total, narrow: TASK_FILTER_KEYS },
        );
      },
    );

    server.tool(
      "get_task",
      "Get one task by its id OR its code (the short ref people share, e.g. PLAT-77 — locked, or PLAT-77* — soft) — its full detail plus its linked commits, activity log/comments, and direct subtasks. Use this before working a task, or any time you need its history/context — including when someone hands you a code like PLAT-77. If it comes back with a non-empty `attachments` array, those are images someone attached as part of the brief: call `get_attachment` on each id to actually see them before you analyze.",
      { id: taskHandle },
      async ({ id }) => {
        const result = await getTask(id, currentUser());
        return result ? text(result) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "get_attachment",
      "Fetch the actual image bytes of an attachment so you can view it. Pass the attachment `id` from a task's `attachments` array (see get_task / list_tasks). Returns the image inline.",
      { id: z.string() },
      async ({ id }) => {
        const att = await getAttachmentById(id, currentUser());
        if (!att) return text({ error: "Attachment not found" });
        try {
          const res = await fetch(att.url);
          if (!res.ok) return text({ error: `Fetch failed (${res.status})` });
          const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
          return image(base64, att.mimeType);
        } catch (e) {
          return text({ error: `Could not load image: ${String(e)}` });
        }
      },
    );

    server.tool(
      "create_task",
      "Create a new task. Only `title` is required. Status defaults to backlog. `value` and `difficulty` are Fibonacci points (1/2/3/5/8); `importance` is the -2…3 priority ladder (default 0 Normal). Pass parentId to create it as a subtask, or boardId to file it onto a specific board (see list_projects). Adding an unfinished subtask to a DONE parent reopens that parent to Review (and moves it out of DONE THIS WEEK) — work underneath it means it isn't finished. PLACEMENT — which canvas group the task lands in, an axis independent of status: it defaults to `inbox` (untriaged), and creating it at analyzing/building implies `thisWeek`. Pass `placement: \"thisWeek\"` when it's to be done this week or you're about to start on it, `\"backlog\"` when it's triaged but not scheduled, `\"later\"` when the user said later, `\"inbox\"` to force it back to untriaged.",
      {
        title: z.string().min(1).max(500),
        status: statusEnum.optional(),
        assigneeIds: assigneeIdsArg.optional(),
        startDate: ymd.optional(),
        dueDate: ymd.optional(),
        recurrence: recurrenceEnum.optional(),
        dependsOn: dependsOnArg.optional(),
        customFields: customFieldsArg.optional(),
        value: fibEnum.optional(),
        difficulty: fibEnum.optional(),
        importance: importanceArg.optional(),
        description: z.string().max(10_000).optional(),
        parentId: taskHandle.optional(),
        boardId: z.string().nullable().optional(),
        placement: placementEnum
          .optional()
          .describe(
            "Which canvas group to file it in: 'inbox' (untriaged, the default), 'thisWeek' (do it this week, or you're starting now), 'backlog' (triaged, not scheduled), 'later' (deferred), 'doneThisWeek' (finished, awaiting a sweep). Omit to let the status decide.",
          ),
        thisWeek: z
          .boolean()
          .optional()
          .describe(
            "Deprecated — use `placement`. true = thisWeek, false = inbox.",
          ),
      },
      // A task born into analyzing/building is assigned to the acting user by
      // the service layer (see ASSIGNING_SOURCES — "mcp" is an agent surface).
      async (input) =>
        text({ task: await createTask(input, currentUser(), AI_AUTHOR) }),
    );

    server.tool(
      "update_task",
      "Update fields on an existing task. Only the fields you pass change. Pass null to clear a nullable field (startDate, dueDate, value, difficulty, description). Pass an empty array to clear assignees/dependsOn. WORKFLOW: `status` is the process spine (backlog → todo → analyzing → analyzed → building → review → done); moving to analyzing or beyond locks the code. Cannot set `done` here — use complete_task, which requires human confirmation. Write the revisable free-text fields here — `analysisSummary` (the Analysis: what & why) and `plan` (the Technical Plan: how) during analysis, and `summary` at the end (a short write-up of what shipped; you can diff git to help). Keep all three concise — length is the driver's call. PLACEMENT: `placement` moves the task between the canvas's groups — 'thisWeek', 'backlog', 'later', 'doneThisWeek', or 'inbox' to send it back to its board's INBOX lane. Moving to analyzing/analyzed/building/review files it on THIS WEEK automatically, but only for a task nobody has filed by hand. Placement never changes status, and status never changes placement beyond that one rule. `end` says WHERE in that group it lands — 'top' for \"do this next\", 'bottom' for the back of the queue.",
      {
        id: taskHandle,
        title: z.string().min(1).max(500).optional(),
        status: statusEnum.optional(),
        assigneeIds: assigneeIdsArg.optional(),
        startDate: ymd.nullable().optional(),
        dueDate: ymd.nullable().optional(),
        recurrence: recurrenceEnum.optional(),
        dependsOn: dependsOnArg.optional(),
        customFields: customFieldsArg.optional(),
        value: fibEnum.nullable().optional(),
        difficulty: fibEnum.nullable().optional(),
        importance: importanceArg.optional(),
        description: z.string().max(10_000).nullable().optional(),
        analysisSummary: z.string().max(20_000).nullable().optional(),
        plan: z.string().max(20_000).nullable().optional(),
        summary: z.string().max(20_000).nullable().optional(),
        placement: placementEnum
          .optional()
          .describe(
            "Move it to a canvas group: 'thisWeek', 'backlog', 'later', 'doneThisWeek', or 'inbox' to send it back to its board's INBOX lane. Omit to let the status decide.",
          ),
        thisWeek: z
          .boolean()
          .optional()
          .describe(
            "Deprecated — use `placement`. true = thisWeek, false = inbox.",
          ),
        end: z
          .enum(["top", "bottom"])
          .optional()
          .describe(
            "Where in the destination group it lands: 'top' (the next thing to pick up) or 'bottom' (behind what's already there). Works with `placement` or on its own, to re-end a task in the group it's already in. Omit unless the order matters — a task with no `end` keeps the position it has.",
          ),
        expectedUpdatedAt: z
          .string()
          .optional()
          .describe(
            "Optional optimistic-lock token: the task's updatedAt from your last read. If provided and the task changed since, the update is rejected as a conflict.",
          ),
      },
      async ({ id, expectedUpdatedAt, ...patch }) => {
        if (patch.status === "done") {
          throw new Error(
            "update_task cannot set status 'done'. Use complete_task — it requires human confirmation.",
          );
        }
        try {
          // Moving into analyzing/building assigns the acting user — handled by
          // the service layer for every agent surface, not passed per call.
          const task = await updateTask(
            id,
            patch,
            currentUser(),
            AI_AUTHOR,
            expectedUpdatedAt,
          );
          return task ? text({ task }) : text({ error: "Task not found" });
        } catch (e) {
          if (e instanceof ConflictError)
            return text({ error: e.message, current: e.current });
          throw e;
        }
      },
    );

    server.tool(
      "move_task",
      "Reorder, re-nest, or re-file a task: change its status (move between groups), parentId (nest under another task, or null for top level), boardId (move onto a board, or null to unassign — see list_projects), canvasSectionId (pin to a canvas Section, or null to unpin), and/or position. Moving into analyzing or building assigns you (existing assignees are kept) and locks the code, exactly as update_task does. Two rules about parents and children: moving a task to done is refused while its own subtasks are unfinished (use complete_task), and nesting an unfinished task under a DONE parent reopens that parent to Review, since work underneath it means it isn't finished.",
      {
        id: taskHandle,
        status: statusEnum.optional(),
        parentId: taskHandle.nullable().optional(),
        boardId: z.string().nullable().optional(),
        position: z.number().optional(),
        // Changing board CLEARS the pin unless one is stated here, so a move that
        // means to keep the card in a Section has to say so.
        canvasSectionId: z.string().nullable().optional(),
        end: z
          .enum(["top", "bottom"])
          .optional()
          .describe(
            "Land at the 'top' or 'bottom' of the group the task ends up in, instead of naming an exact `position`. An explicit `position` wins.",
          ),
      },
      async ({ id, ...target }) => {
        const task = await moveTask(id, target, currentUser(), AI_AUTHOR);
        return task ? text({ task }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "complete_task",
      "Mark a task done (default), or reopen it with done:false (sends it back to Planned). A PARENT closes after its children: completing one that still has unfinished subtasks is refused, and the error names them — finish those first, or pass withSubtasks:true to close the whole branch (every unfinished descendant, then the task). Only pass it when the human asked to finish the branch; it marks work done that nobody completed one by one. Reopening a task that was parked in DONE THIS WEEK also moves it back to THIS WEEK, since a task that isn\'t done doesn\'t belong in the done tray.",
      {
        id: taskHandle,
        done: z.boolean().optional().default(true),
        withSubtasks: z.boolean().optional(),
      },
      async ({ id, done, withSubtasks }) => {
        const task = await completeTask(id, done, currentUser(), AI_AUTHOR, {
          withSubtasks,
        });
        return task ? text({ task }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "archive_task",
      "Archive a done task (default), or un-archive it with archived:false. Archiving hides a finished task from all active views (boards, lists, canvas) while keeping it in the Archived view; it stays done. Only tasks that are already done can be archived.",
      { id: taskHandle, archived: z.boolean().optional().default(true) },
      async ({ id, archived }) => {
        const task = await archiveTask(id, archived, currentUser(), AI_AUTHOR);
        return task ? text({ task }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "add_comment",
      "Add a note/comment to a task's activity log.",
      { id: taskHandle, message: z.string().min(1).max(10_000) },
      async ({ id, message }) => {
        const comment = await addComment(id, message, currentUser(), AI_AUTHOR);
        return comment ? text({ comment }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "delete_task",
      "Delete a task — into the Trash, not out of existence. It leaves every board, list, canvas and search (and stops accepting edits), keeps its ref and its subtasks, and can be restored with restore_task. Its subtasks go with it and come back with it. Pass `forever: true` ONLY to purge a task that is ALREADY in the Trash — that drops its rows, logs and images for good and cannot be undone, so ask the human first.",
      { id: taskHandle, forever: z.boolean().optional().default(false) },
      async ({ id, forever }) =>
        text(
          forever
            ? { ok: await purgeTask(id, currentUser()), deleted: "forever" }
            : { ok: await deleteTask(id, currentUser(), AI_AUTHOR), deleted: "trash" },
        ),
    );

    server.tool(
      "restore_task",
      "Bring a task back from the Trash, with its subtasks. Find deleted tasks with search_tasks deletedOnly:true (they're hidden from every normal read). A task whose parent is still deleted comes back at top level.",
      { id: taskHandle },
      async ({ id }) => {
        const task = await restoreTask(id, currentUser(), AI_AUTHOR);
        return task ? text({ task }) : text({ error: "Task not found in the Trash" });
      },
    );

    server.tool(
      "search_tasks",
      "The FLAT-list twin of list_tasks — same filters, one row per task, no nesting. Good for targeted questions ('what's overdue?', \"what's assigned to Simon?\", 'what did I finish last week?'). Unlike list_tasks it includes done tasks unless you pass includeDone:false, since search is often looking for finished work. Defaults to detail:'compact'; it never returns the free-text working fields unless you ask for detail:'full', and those must not be used to infer where code lives.",
      {
        ...taskFilterShape,
        detail: taskDetailSchema.optional().default("compact"),
        format: z.enum(["json", "markdown"]).optional().default("json"),
      },
      async ({ format, detail, ...filter }) => {
        // See list_tasks: fetch the working fields only for detail:'full'.
        const f = { ...(await resolveFilter(filter)), includeWorkingFields: detail === "full" };
        const [result, total] = await Promise.all([
          searchTasks(currentUser(), f),
          countTasks(currentUser(), f),
        ]);
        if (format === "markdown")
          return text(toMarkdown(result, await userNameMap()));
        return text(
          {
            count: result.length,
            total,
            tasks: result.map((t) => projectTask(t, detail)),
          },
          { items: "tasks", total, narrow: TASK_FILTER_KEYS },
        );
      },
    );

    /* ----------------------------------------------------------------- */
    /* WORKFLOW — the process layer: lock the code, link commits. See     */
    /* work_on_task / finish_task prompts for the protocol. All auto-fire  */
    /* lifecycle timestamps.                                               */
    /* ----------------------------------------------------------------- */

    server.tool(
      "lock_task",
      "Lock (freeze) a task's human code so it's stable to cite in commits — e.g. GH-20* becomes GH-20. Taking the handoff also assigns you (existing assignees are kept). Idempotent: locking an already-locked task just returns it. Normally you don't call this directly — the work_on_task prompt locks on handoff — but call it if you're about to commit work referencing a task whose code is still soft (ends with *).",
      { id: taskHandle },
      async ({ id }) => {
        const task = await mintRef(id, currentUser(), AI_AUTHOR);
        return task ? text({ task }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "link_commit",
      "Record a git commit against a task so the task page lists what shipped it. Pass the `sha` (and ideally the `subject` line). Idempotent per (task, sha). Commit messages should reference the task's locked code, e.g. `[GH-20] …`.",
      {
        id: taskHandle,
        sha: z.string().min(4).max(64),
        subject: z.string().max(500).optional(),
      },
      async ({ id, sha, subject }) => {
        const c = await linkCommit(id, sha, subject ?? null, currentUser());
        return c ? text({ commit: c }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "standup",
      "Assemble a standup digest for a date window. Dates are ISO/YYYY-MM-DD and BOTH ENDS COUNT — from = to is a valid single-day window covering that whole day.\n" +
        "\n" +
        "Work is attributed to WHOSE WORK IT IS, recorded when each status change happened: the assignee when a card was moved in the web UI (moving a card is scheduling, not doing), the actor on agent surfaces. So a task someone else closed on your behalf is NOT yours, and one you built but someone else closed still is. Defaults to you; pass `credited` for a teammate or `\"team\"` for everyone.\n" +
        "\n" +
        "Four disjoint lists: `shipped` (reached done, and you worked a stage on it), `handled` (reached done with no working stage — non-code work taken straight to done; say \"handled\", never \"built\"), `worked` (still in flight, with the stage stints you did), and `closedUnattributed` (reached done with nobody creditable — `closedBy` says who pressed the button, which is on the record but is NOT their work). An `attribution` field, when present, means the window predates the record — treat it as missing data, not an empty day.",
      {
        from: z.string().min(1).max(40).describe("start of window (inclusive)"),
        to: z.string().min(1).max(40).describe("end of window (inclusive)"),
        credited: z
          .string()
          .max(120)
          .optional()
          .describe('whose work — id, email, name, "me" (default), or "team" for everyone'),
      },
      async ({ from, to, credited }) => {
        // Absent means ME, not "everyone" — only an explicit "team" widens it.
        const who =
          credited === undefined
            ? currentUser()
            : /^(team|all|everyone|\*)$/i.test(credited.trim())
              ? null
              : ((await resolveFilter({ actor: credited })).actor ?? NO_SUCH_USER);
        const digest = await activityDigest(currentUser(), {
          from,
          to,
          credited: who,
        });
        // A digest wants "what shipped", which is the `summary`. Carrying each
        // task's plan + analysis + description as well multiplies the payload
        // several times over for material nobody reads here.
        const entry = (e: {
          task: TaskDTO;
          stints: unknown[];
          moves: unknown[];
        }) => ({
          ...projectTask(e.task, "compact"),
          summary: e.task.summary,
          // `stints` = time actively working (analyzing/building only).
          // `moves` = every credited transition, so "handed the analysis over"
          // is visible even though it has no work time of its own.
          stints: e.stints,
          moves: e.moves,
        });
        return text(
          {
            from,
            to,
            credited: who === null ? "team" : who,
            ...(digest.attribution ? { attribution: digest.attribution } : {}),
            shipped: digest.shipped.map(entry),
            handled: digest.handled.map(entry),
            worked: digest.worked.map(entry),
            closedUnattributed: digest.closedUnattributed.map((c) => ({
              ...projectTask(c.task, "compact"),
              closedBy: c.closedBy,
            })),
          },
          {
            // Shipped tasks carry their full summaries, so a wide window is the
            // one read that reliably runs long. Cut those first.
            items: "shipped",
            narrow: ["from", "to", "credited"],
          },
        );
      },
    );

    /* ----------------------------------------------------------------- */
    /* WORK DAYS — the day's record. The contract these follow is        */
    /* `DAY_CLOSE` (in the server instructions), so the steps an agent    */
    /* walks and the ones the UI shows are the same steps.               */
    /* ----------------------------------------------------------------- */

    server.tool(
      "work_day",
      "Everything the end-of-day close-out needs for one project on one working day, in one read: `day` (the row, with `sealed`), `digest` (what you did — same four disjoint lists as `standup`), `candidates` (tasks you actually touched that day and left in a late work status — the \"which of these finished?\" list, PROPOSALS only), and `drift` when a morning snapshot exists (`plannedNotDone`, and `doneNotPlanned` — the day's real interruptions).\n" +
        "\n" +
        "`openDays` lists EARLIER working days with the person's work on them that were never closed out. Raise those before writing today's standup — an unclosed day is work missing from the record, and nothing else surfaces it.\n" +
        "\n" +
        "A working day runs 04:00 → 04:00 local, so work finished at 01:00 belongs to the previous day. You do NOT need a row to exist: a day exists because there was work in it, and this answers for any date. Walk the close-out per the `DAY_CLOSE` contract, then record it with `finish_work`.",
      {
        projectId: z.string().max(120).describe("which project's day (see list_projects)"),
        day: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("the working day, YYYY-MM-DD"),
        tz: z
          .string()
          .max(60)
          .optional()
          .describe('IANA zone the day is read in, e.g. "Europe/Brussels" (default UTC)'),
      },
      async ({ projectId, day, tz }) => {
        const review = await workDayReview(currentUser(), projectId, day, tz);
        return text(
          {
            day: review.day,
            ...(review.openDays.length ? { openDays: review.openDays } : {}),
            ...(review.digest.attribution
              ? { attribution: review.digest.attribution }
              : {}),
            candidates: review.candidates.map((t) => projectTask(t, "compact")),
            shipped: review.digest.shipped.map((e) => ({
              ...projectTask(e.task, "compact"),
              summary: e.task.summary,
            })),
            handled: review.digest.handled.map((e) =>
              projectTask(e.task, "compact"),
            ),
            worked: review.digest.worked.map((e) => ({
              ...projectTask(e.task, "compact"),
              stints: e.stints,
            })),
            closedUnattributed: review.digest.closedUnattributed.map((c) => ({
              ...projectTask(c.task, "compact"),
              closedBy: c.closedBy,
            })),
            ...(review.drift
              ? {
                  drift: {
                    plannedNotDone: review.drift.plannedNotDone,
                    doneNotPlanned: review.drift.doneNotPlanned.map((t) =>
                      projectTask(t, "compact"),
                    ),
                  },
                }
              : {}),
          },
          { items: "shipped", narrow: ["projectId", "day"] },
        );
      },
    );

    server.tool(
      "ready_for_day",
      "\"Ready for the day\": freeze what's in THIS WEEK for this project right now, so it can be reviewed later against what actually happened (\"was my list clear enough?\"). THIS WEEK is a mutable bucket, so this list is otherwise lost by evening.\n" +
        "\n" +
        "Pressing it again overwrites — the last arrangement of the morning is the real commitment. It is NOT a crediting boundary: it changes no dates and nothing depends on it, so skipping it costs only the snapshot.",
      {
        projectId: z.string().max(120),
        day: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("the working day, YYYY-MM-DD"),
      },
      async ({ projectId, day }) =>
        text({ day: await markDayReady(currentUser(), projectId, day) }),
    );

    server.tool(
      "finish_work",
      "\"Finish work\": record the day's standup write-up and mark it drafted. Call this LAST, after walking the close-out from `work_day` — completing what finished (each through `complete_task`, with its own confirmation) and logging untracked work with `log_past_work`.\n" +
        "\n" +
        "This completes NOTHING itself: batch the asking, never the deciding. The day stays correctable after this (things get split at the standup), and seals itself once a LATER day is drafted — so this refuses a day that is already sealed, because late work belongs to the current day rather than to a standup already presented.",
      {
        projectId: z.string().max(120),
        day: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("the working day, YYYY-MM-DD"),
        summary: z
          .string()
          .max(20_000)
          .optional()
          .describe("the standup write-up — see the DAY_CLOSE contract for the shape"),
        bullets: z
          .string()
          .max(10_000)
          .optional()
          .describe('points that aren\'t about any one task ("out Thursday")'),
      },
      async ({ projectId, day, summary, bullets }) =>
        text({
          day: await finishWork(currentUser(), projectId, day, {
            summary,
            bullets,
          }),
        }),
    );

    server.tool(
      "log_past_work",
      "Log work that never reached the board — a call, a conversation, an errand. Creates a real task, already done, credited to the working day it actually happened on and filed straight into DONE THIS WEEK (so it never sits in a triage lane).\n" +
        "\n" +
        "This is the answer to \"what did you do that isn't here?\" in the close-out: work with no commit and no status change can't be found by reconciling the board, so it has to be asked for. One record for everything — don't keep this kind of work anywhere but the board.",
      {
        title: z.string().min(1).max(500),
        day: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("the working day the work actually happened on"),
        boardId: z
          .string()
          .max(120)
          .nullable()
          .optional()
          .describe("which board it belongs on (see list_projects)"),
        description: z.string().max(10_000).optional(),
      },
      async ({ title, day, boardId, description }) =>
        text({
          task: await logPastWork(currentUser(), {
            title,
            day,
            boardId,
            description,
            author: AI_AUTHOR,
          }),
        }),
    );

    /* ----------------------------------------------------------------- */
    /* BOARD REVIEW — the cleanup pass. Evidence for reconciling what the */
    /* board claims against what the repo shows (`BOARD_CLEANUP`).        */
    /* ----------------------------------------------------------------- */

    server.tool(
      "board_review",
      "Everything a CLEANUP pass needs about one project (or board) in one read: what's on-going, what changed in the window, what's been sitting still, and deterministic hygiene flags. Nothing to do with the `review` status or `review` notes — this is the whole board's in-flight state.\n" +
        "\n" +
        "This returns EVIDENCE, NEVER CONCLUSIONS. It cannot know whether work is done — only the repo knows that, so you must read the code before proposing anything. `flags` are OBSERVATIONS: `buildingNoCommits` might be stalled work, work on a branch, or work needing no commit at all. Treat every flag as a question to answer against the code, and walk the `BOARD_CLEANUP` contract in your server instructions (or the `todo://cleanup` resource).\n" +
        "\n" +
        "On-going means: statuses analyzing/analyzed/building/review, PLUS anything in THIS WEEK that isn't done, PLUS INBOX (untriaged), PLUS tasks that are done but still sitting outside DONE THIS WEEK. Each task's `why` says which of those put it here. Scope is REQUIRED (`projectId` or `boardId`) — an unscoped review would read the whole board; `list_projects` has the ids and each project's `gitFolder`.\n" +
        "\n" +
        "Tasks come back WORST-FIRST (flag severity, then longest-sitting), which is the order to work them in and what makes a truncated read safe. `onlyFlagged: true` is the way to narrow one. Staleness is measured over ALL history in WORKING days (weekends excluded), so a Monday pass still finds a task last touched three Fridays ago; the window only decides what counts as \"what changed\". `thresholds` ships the day counts the flags used, so you can explain the number. Read `caveats` before drawing any conclusion — chiefly: a log entry records THAT a field changed, not what it changed from, and title/description edits aren't logged at all (that's the `silentEdit` flag). `writeUps` are the last week's standups — what was said about the work in the user's own words. `has` gives the LENGTH of analysis/plan/summary, not the text: `get_task` the handful you'll actually act on. `elsewhere` is on-going work in other projects, refs only.",
      {
        projectId: z
          .string()
          .max(120)
          .optional()
          .describe("which project's board (see list_projects)"),
        boardId: z
          .string()
          .max(120)
          .optional()
          .describe(
            "narrow to one board. Trays are still resolved project-wide (placement lives on the project's canvas), then candidates are filtered to this board.",
          ),
        from: z
          .string()
          .max(40)
          .optional()
          .describe(
            'start of the EVIDENCE window, YYYY-MM-DD or ISO (default: the current working day). Not a filter on which tasks match — staleness always spans all history.',
          ),
        to: z.string().max(40).optional().describe("end of the window (inclusive)"),
        tz: z
          .string()
          .max(60)
          .optional()
          .describe('IANA zone the days mean, e.g. "Europe/Brussels"'),
        status: z
          .array(statusEnum)
          .optional()
          .describe(
            "override what counts as on-going (default: analyzing, analyzed, building, review)",
          ),
        includeThisWeek: z
          .boolean()
          .optional()
          .describe(
            "also include anything filed in THIS WEEK that isn't done, whatever its status (default true)",
          ),
        includeInbox: z
          .boolean()
          .optional()
          .describe("also include untriaged INBOX tasks (default true)"),
        includeUnswept: z
          .boolean()
          .optional()
          .describe(
            "also include tasks that are done but still outside DONE THIS WEEK (default true)",
          ),
        onlyFlagged: z
          .boolean()
          .optional()
          .describe(
            "only tasks carrying at least one flag — THE way to narrow a truncated read",
          ),
        limit: z.number().int().min(1).max(100).optional(),
      },
      async ({ projectId, boardId, ...rest }) => {
        // A helpful answer rather than a thrown error: the caller almost always
        // just needs the ids, and `list_projects` is a second round-trip.
        if (!projectId && !boardId) {
          const projects = await listProjects(currentUser());
          return text({
            error:
              "board_review needs a projectId or boardId — an unscoped review would read the whole board.",
            projects: projects.map((p) => ({
              id: p.id,
              name: p.name,
              gitFolder: p.gitFolder,
              boards: (p.boards ?? []).map((b) => ({
                id: b.id,
                name: b.name,
                gitFolder: b.gitFolder,
              })),
            })),
          });
        }
        const review = await boardReview(currentUser(), {
          ...(projectId ? { projectId } : {}),
          ...(boardId ? { boardId } : {}),
          ...rest,
        });
        return text(
          {
            ...review,
            tasks: review.tasks.map((r) => ({
              ...r,
              // Compact, plus the one timestamp a cleanup needs: `updatedAt` is
              // what goes back as `expectedUpdatedAt` on every write, since the
              // user may be moving cards while the agent talks.
              task: {
                ...projectTask(r.task, "compact"),
                ...(r.task.updatedAt ? { updatedAt: r.task.updatedAt } : {}),
              },
            })),
          },
          {
            items: "tasks",
            total: review.total,
            narrow: [
              "onlyFlagged",
              "boardId",
              "status",
              "limit",
              "includeInbox",
              "includeUnswept",
              "includeThisWeek",
              "from",
              "to",
            ],
          },
        );
      },
    );

    /* ----------------------------------------------------------------- */
    /* PROJECTS & BOARDS — so the AI can see + shape the hierarchy and    */
    /* file tasks onto the right board (deletes omitted on purpose).      */
    /* ----------------------------------------------------------------- */

    server.tool(
      "list_users",
      "List the roster — everyone who can be assigned to tasks or added as a project member. Each user has `id`, `name` (the display name used in a task's `assignees`), `email`, and `color`. Use this to resolve who to assign or add to a project.",
      {},
      async () => text({ users: await listUsers() }),
    );

    server.tool(
      "list_projects",
      `List your projects, each with its boards. Every project AND board includes: \`id\`, \`name\`, \`code\` (its ≤4-char shortname / ref prefix, e.g. "GH"), \`color\` (hex), \`image\` (picture URL or null), \`gitFolder\` (the path to its git working directory — where its code lives on disk, or null if unset), and \`description\` (a Markdown readme explaining what it is and its constraints, or null). Projects also include \`members\` — the roster users ({id, name, email}) the assignee picker offers on that project's tasks (empty ⇒ the whole roster is offered). READ each \`description\` and \`gitFolder\` first to understand what a project/board is about and where its code lives before working on its tasks. ${SYNC_NOTE} Use a board \`id\` as the \`boardId\` when creating or moving tasks to file them under the right board.`,
      {},
      async () => {
        const [projectList, roster] = await Promise.all([
          listProjects(currentUser()),
          listUsers(),
        ]);
        const projects = projectList.map((p) => ({
          ...p,
          members: membersToPublic(p.members ?? [], roster),
        }));
        return text({ projects });
      },
    );

    server.tool(
      "create_project",
      "Create a new project (a top-level container for boards). Besides the name you can set: `code` (the project's ≤4-char shortname / ref prefix, used for tasks scoped to the project but no board; auto-derived from the name if omitted), `color` (#rrggbb hex accent), `image` (a public picture URL), `gitFolder` (the path to the project's git working directory — where its code lives), `description` (a Markdown readme explaining what the project is, its purpose, and constraints), and `members` (roster users allowed as assignees on this project's tasks — exactly these; none ⇒ the whole roster is offered). ALWAYS write a `description` so that AIs without access to the code can understand the project.",
      {
        name: z.string().min(1).max(120),
        code: z
          .string()
          .min(1)
          .max(8)
          .optional()
          .describe("Shortname / ref prefix (≤4 chars used)"),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Accent color as a #rrggbb hex string"),
        image: z
          .string()
          .url()
          .max(2048)
          .optional()
          .describe("Project picture — a public image URL"),
        gitFolder: z
          .string()
          .max(512)
          .optional()
          .describe("Path to the project's git working directory (where its code lives)"),
        description: z
          .string()
          .max(20000)
          .optional()
          .describe(
            `Markdown readme: what the project is, its purpose, and constraints. ${SYNC_NOTE}`,
          ),
        members: z
          .array(z.string().min(1))
          .max(50)
          .optional()
          .describe(
            "Members to add — each a user id, email, or display name (resolved via list_users). Exactly these are set; unknown names are skipped.",
          ),
      },
      async ({ name, code, color, image, gitFolder, description, members }) => {
        const resolved = members
          ? await resolveMemberIdentifiers(members)
          : { ids: [], unresolved: [] };
        const project = await createProject(currentUser(), name, {
          code,
          color,
          image,
          gitFolder,
          description,
          members: resolved.ids,
        });
        return text({
          project,
          ...(resolved.unresolved.length
            ? { unresolvedMembers: resolved.unresolved }
            : {}),
        });
      },
    );

    server.tool(
      "create_board",
      "Create a board inside a project. Besides the name you can set: `code` (the board's ≤4-char shortname / ref prefix used in task refs, e.g. \"GH\" → GH-12; auto-derived from the name if omitted), `color` (a #rrggbb hex accent), `image` (a public picture URL), `gitFolder` (the path to this board's git working directory so you know where its code lives on disk), and `description` (a Markdown readme explaining what the board is, its purpose, and constraints). ALWAYS write a `description` so that AIs without access to the code can understand the board. Returns an error if the project isn't found or isn't yours.",
      {
        projectId: z.string(),
        name: z.string().min(1).max(120),
        code: z
          .string()
          .min(1)
          .max(8)
          .optional()
          .describe("Shortname / ref prefix (≤4 chars used), e.g. \"GH\""),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Accent color as a #rrggbb hex string"),
        image: z
          .string()
          .url()
          .max(2048)
          .optional()
          .describe("Board picture — a public image URL"),
        gitFolder: z
          .string()
          .max(512)
          .optional()
          .describe("Path to the board's git working directory (where its code lives)"),
        description: z
          .string()
          .max(20000)
          .optional()
          .describe(
            `Markdown readme: what the board is, its purpose, and constraints. ${SYNC_NOTE}`,
          ),
      },
      async ({ projectId, name, code, color, image, gitFolder, description }) => {
        const board = await createBoard(currentUser(), projectId, name, {
          code,
          color,
          image,
          gitFolder,
          description,
        });
        return board ? text({ board }) : text({ error: "Project not found" });
      },
    );

    server.tool(
      "rename_board",
      "Update a board: rename it, and/or change its `code` (≤4-char shortname / ref prefix, e.g. \"GH\"), `color` (#rrggbb hex), `image` (picture URL, or null to clear), `gitFolder` (path to the board's git working directory, or null to clear), or `description` (a Markdown readme of what the board is and its constraints, or null to clear). A code change only affects tasks whose code is still soft (unlocked) — locked refs are frozen. The code is kept unique across your boards/projects.",
      {
        id: z.string(),
        name: z.string().min(1).max(120).optional(),
        code: z
          .string()
          .min(1)
          .max(8)
          .optional()
          .describe("Shortname / ref prefix (≤4 chars used), e.g. \"GH\""),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Accent color as a #rrggbb hex string"),
        image: z
          .string()
          .url()
          .max(2048)
          .nullable()
          .optional()
          .describe("Board picture URL, or null to clear"),
        gitFolder: z
          .string()
          .max(512)
          .nullable()
          .optional()
          .describe("Path to the board's git working directory, or null to clear"),
        description: z
          .string()
          .max(20000)
          .nullable()
          .optional()
          .describe(`Markdown readme of the board, or null to clear. ${SYNC_NOTE}`),
      },
      async ({ id, name, code, color, image, gitFolder, description }) => {
        const board = await updateBoard(currentUser(), id, {
          name,
          code,
          color,
          image,
          gitFolder,
          description,
        });
        return board ? text({ board }) : text({ error: "Board not found" });
      },
    );

    server.tool(
      "rename_project",
      "Update a project: rename it, and/or change its `code` (≤4-char shortname / ref prefix, used as a task's ref prefix when it has no board), `color` (#rrggbb hex), `image` (picture URL, or null to clear), `gitFolder` (path to the project's git working directory, or null to clear), or `description` (a Markdown readme of what the project is and its constraints, or null to clear). Code is kept unique across your boards/projects.",
      {
        id: z.string(),
        name: z.string().min(1).max(120).optional(),
        code: z
          .string()
          .min(1)
          .max(8)
          .optional()
          .describe("Shortname / ref prefix (≤4 chars used)"),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Accent color as a #rrggbb hex string"),
        image: z
          .string()
          .url()
          .max(2048)
          .nullable()
          .optional()
          .describe("Project picture URL, or null to clear"),
        gitFolder: z
          .string()
          .max(512)
          .nullable()
          .optional()
          .describe("Path to the project's git working directory, or null to clear"),
        description: z
          .string()
          .max(20000)
          .nullable()
          .optional()
          .describe(`Markdown readme of the project, or null to clear. ${SYNC_NOTE}`),
      },
      async ({ id, name, code, color, image, gitFolder, description }) => {
        const project = await updateProject(currentUser(), id, {
          name,
          code,
          color,
          image,
          gitFolder,
          description,
        });
        return project ? text({ project }) : text({ error: "Project not found" });
      },
    );

    server.tool(
      "add_project_member",
      "Add a member to a project — a roster user who can then be assigned to that project's tasks (the assignee picker on the project's tasks offers only its members, or the whole roster if it has none). The member is a user id, email, or display name (resolve with list_users). Returns the project's new member list, or an error if the project isn't yours or the user is unknown.",
      {
        projectId: z.string(),
        member: z
          .string()
          .min(1)
          .describe("A user id, email, or display name (e.g. \"Simon\")"),
      },
      async ({ projectId, member }) => {
        const { ids, unresolved } = await resolveMemberIdentifiers([member]);
        if (!ids.length)
          return text({ error: `Unknown user: ${unresolved[0] ?? member}` });
        const memberIds = await addProjectMember(currentUser(), projectId, ids[0]);
        if (!memberIds) return text({ error: "Project not found" });
        return text({ members: membersToPublic(memberIds, await listUsers()) });
      },
    );

    server.tool(
      "remove_project_member",
      "Remove a member from a project. The member is a user id, email, or display name. Removing a member does NOT un-assign them from existing tasks — assignees are kept as-is. Returns the project's new member list, or an error if the project isn't found.",
      {
        projectId: z.string(),
        member: z
          .string()
          .min(1)
          .describe("A user id, email, or display name (e.g. \"Simon\")"),
      },
      async ({ projectId, member }) => {
        const { ids, unresolved } = await resolveMemberIdentifiers([member]);
        if (!ids.length)
          return text({ error: `Unknown user: ${unresolved[0] ?? member}` });
        const memberIds = await removeProjectMember(currentUser(), projectId, ids[0]);
        if (!memberIds) return text({ error: "Project not found" });
        return text({ members: membersToPublic(memberIds, await listUsers()) });
      },
    );

    server.tool(
      "bulk_update",
      "Apply the SAME change to many tasks at once — the efficient path for edits like 'assign these to Simon', 'move these to Planned', or 'set these to done'. `patch` accepts the same fields as update_task (null clears a nullable field; an empty array clears assignees/dependsOn). A patch that sets analyzing or building assigns you on each task and locks its code, as update_task does. Tasks you don't own are silently skipped and returned in `skipped`. A `status:\'done\'` patch also refuses any task with unfinished subtasks — those come back in `blocked` with their open counts (the rest of the batch still applies), so report them rather than retrying.",
      { ids: z.array(taskHandle).min(1).max(500), patch: updateTaskSchema },
      async ({ ids, patch }) =>
        text(await bulkUpdate(currentUser(), ids, patch, AI_AUTHOR)),
    );

    server.tool(
      "bulk_apply",
      "Run an ORDERED list of mixed operations in one call — the power tool for real reorganization (build a roadmap, move some, complete a sprint). Each op is one of create/update/move/complete/comment/archive/delete. `archive` cascades to the subtree and only accepts a done task, so complete it earlier in the same batch (ops run in array order). Ops that set analyzing or building assign you and lock the code, as the single-task tools do. Best-effort: a failing op is reported in `results` and the batch continues, so partial failure is visible. Capped at 200 ops (extra are dropped and flagged via `truncated`).",
      { operations: z.array(bulkOpSchema).min(1) },
      async ({ operations }) =>
        text(await bulkApply(currentUser(), operations, AI_AUTHOR)),
    );

    /* ----------------------------------------------------------------- */
    /* CANVAS — free-form whiteboards for brainstorming.                  */
    /* ----------------------------------------------------------------- */

    server.tool(
      "list_canvases",
      "List the canvases. A canvas is a project's whiteboard — EXACTLY one per project, laying out that project's boards as sections. Canvases are team-visible. Pass `projectId` to get one project's (0 or 1 rows). Returns each canvas's id, projectId, name and timestamps — no nodes. Use get_canvas to read a canvas's contents.",
      { projectId: z.string().optional() },
      async ({ projectId }) => text({ canvases: await listCanvases(projectId) }),
    );

    server.tool(
      "get_canvas",
      "Get one canvas by id with all its nodes. A canvas belongs to exactly one project (`projectId`) and lays out that project's boards; a task's `placement` resolves against ITS OWN project's canvas. Positions/sizes are in canvas coordinates. Node `kind` is one of: `text` (markdown in `content`), `section` (a titled container of a board's tasks — `content` is its label, `data.boardId` its board), `section_group` (a container that arranges member sections; each member carries `data.groupId`), `draw` and `image`. Some groups are special — each is the canvas end of a `placement`, and carries its name as a `data` flag on the group and on every lane inside it. `data.inbox` is the machine-managed INBOX tray, one lane per board, holding every task nobody filed anywhere (an inbox lane means UNPINNED, so nothing points at it). `data.thisWeek`, `data.backlog`, `data.later` and `data.doneThisWeek` are the other machine-managed trays — this week's board, triaged-not-scheduled, deferred, and finished-awaiting-a-sweep. THIS WEEK is where create_task/update_task put anything with `placement: \"thisWeek\"` (or moved into analyzing/building); every section inside it is its board's master, the target of other sections' \"Send to\" button. A tray's lanes are machine-made, but a section you add to a tray by hand is an ordinary section and is PREFERRED over a derived lane, so hand-named lanes are what work actually lands in.",
      { id: z.string() },
      async ({ id }) => {
        const canvas = await getCanvas(id);
        if (!canvas) return text({ error: "Canvas not found" });
        return text({ canvas });
      },
    );

    server.tool(
      "create_canvas",
      "Create a project's (empty) canvas. A project has exactly one canvas, so this fails if it already has one — every project gets one when it's created, so you rarely need this.",
      { name: z.string().min(1).max(120), projectId: z.string() },
      async ({ name, projectId }) =>
        text({ canvas: await createCanvas(currentUser(), name, projectId) }),
    );

    /* ----------------------------------------------------------------- */
    /* CALENDAR — Google Calendar, read-through. Every connected calendar */
    /* (the shared one + everyone's personal) is team-visible & writable. */
    /* ----------------------------------------------------------------- */

    server.tool(
      "list_calendars",
      "List the connected Google calendars available to write to (the shared team calendar plus each person's personal calendar). Use a returned `id` as the `calendar` argument to create/update/delete events on a specific one; omit it to target the shared calendar. A calendar's `type` (e.g. \"holidays\") can also be passed as `calendar` to target it by role — use this to manage the holidays calendar.",
      {},
      async () =>
        text({
          calendars: (await listPublicConnections()).map((c) => ({
            id: c.id,
            label: c.label,
            scope: c.scope,
            type: c.type,
            owner: c.ownerName,
            googleEmail: c.googleEmail,
          })),
        }),
    );

    server.tool(
      "list_calendar_events",
      "List Google Calendar events across ALL connected calendars (shared + everyone's personal) within a date range. Dates are YYYY-MM-DD (inclusive). Each event includes its `id`, the `connectionId` (pass as `calendar` to edit/delete it), the owner, and start/end.",
      {
        from: ymd.describe("start of range, YYYY-MM-DD"),
        to: ymd.describe("end of range, YYYY-MM-DD"),
      },
      async ({ from, to }) => text({ events: await listEvents(from, to) }),
    );

    server.tool(
      "create_calendar_event",
      "Create a Google Calendar event. `calendar` is a connection id from list_calendars, a type tag like \"holidays\" (to add to the holidays calendar), or omit it to use the shared team calendar. For an all-day event pass `allDay:true` and a `start` (and optional `end`) as YYYY-MM-DD; otherwise pass RFC3339 datetimes (e.g. 2026-07-20T14:00:00).",
      {
        title: z.string().min(1).max(500),
        start: z.string().min(1).max(40),
        end: z.string().min(1).max(40).optional(),
        allDay: z.boolean().optional(),
        description: z.string().max(10_000).optional(),
        location: z.string().max(500).optional(),
        calendar: z
          .string()
          .max(120)
          .optional()
          .describe('Connection id, a type tag like "holidays", or "shared" / omitted for the shared calendar.'),
      },
      async ({ calendar, ...event }) => {
        try {
          return text({ event: await createEvent(calendar, event) });
        } catch (e) {
          if (e instanceof CalendarError) return text({ error: e.message });
          throw e;
        }
      },
    );

    server.tool(
      "update_calendar_event",
      "Update a Google Calendar event. `id` is the event id and `calendar` is the connectionId it lives on (both from list_calendar_events). Only the fields you pass change.",
      {
        id: z.string(),
        calendar: z.string().min(1).max(120),
        title: z.string().min(1).max(500).optional(),
        start: z.string().min(1).max(40).optional(),
        end: z.string().min(1).max(40).optional(),
        allDay: z.boolean().optional(),
        description: z.string().max(10_000).optional(),
        location: z.string().max(500).optional(),
      },
      async ({ id, calendar, ...patch }) => {
        try {
          return text({ event: await updateEvent(calendar, id, patch) });
        } catch (e) {
          if (e instanceof CalendarError) return text({ error: e.message });
          throw e;
        }
      },
    );

    server.tool(
      "delete_calendar_event",
      "Delete a Google Calendar event. `id` is the event id and `calendar` is the connectionId it lives on (both from list_calendar_events).",
      { id: z.string(), calendar: z.string().min(1).max(120) },
      async ({ id, calendar }) => {
        try {
          return text({ ok: await deleteEvent(calendar, id) });
        } catch (e) {
          if (e instanceof CalendarError) return text({ error: e.message });
          throw e;
        }
      },
    );

    /* ----------------------------------------------------------------- */
    /* RESOURCES — read-only, attachable context (no tool call needed).   */
    /* ----------------------------------------------------------------- */

    server.registerResource(
      "board",
      "todo://board",
      {
        title: "My board (Markdown)",
        description:
          "The whole board as compact Markdown — skimmable context.",
        mimeType: "text/markdown",
      },
      async (uri) =>
        md(uri.href, toMarkdown(await listTasks(currentUser()), await userNameMap())),
    );

    server.registerResource(
      "board-json",
      "todo://board.json",
      {
        title: "My board (JSON)",
        description:
          "Nested task tree of the ACTIVE board (done tasks excluded — use list_tasks with a window for those), one compact row per task. Omits descriptions and the free-text working fields (analysisSummary, plan, summary) — get_task a task for those; don't infer code locations from another task's notes.",
        mimeType: "application/json",
      },
      async (uri) =>
        json(uri.href, {
          tasks: (
            await listTasks(currentUser(), { includeDone: false })
          ).map((t) => projectTask(t, "compact")),
        }),
    );

    server.registerResource(
      "today",
      "todo://today",
      {
        title: "Today",
        description:
          "In-progress + planned tasks, plus anything due today or overdue.",
        mimeType: "text/markdown",
      },
      async (uri) =>
        md(uri.href, toMarkdown(await listToday(currentUser()), await userNameMap())),
    );

    server.registerResource(
      "workflow",
      "todo://workflow",
      {
        title: "How to work a task",
        description:
          "The canonical todo workflow contract — how an AI should behave when starting, working, or finishing a task. Same text as the server instructions; read it whenever you begin or modify work.",
        mimeType: "text/markdown",
      },
      async (uri) => md(uri.href, WORKFLOW),
    );

    server.registerResource(
      "cleanup",
      "todo://cleanup",
      {
        title: "How to clean up the board",
        description:
          "The board-cleanup contract — how to reconcile what the board claims against what the repo shows. Read it before acting on a `board_review`.",
        mimeType: "text/markdown",
      },
      async (uri) => md(uri.href, BOARD_CLEANUP),
    );

    server.registerResource(
      "task",
      new ResourceTemplate("todo://task/{id}", {
        // Let clients browse the current task ids as addressable resources.
        list: async () => ({
          resources: (await listTasksFlat(currentUser())).map((t) => ({
            uri: `todo://task/${t.id}`,
            name: t.title,
            description: `[${t.status}] ${t.title}`,
            mimeType: "application/json",
          })),
        }),
      }),
      {
        title: "Task detail",
        description: "One task with its full activity log.",
        mimeType: "application/json",
      },
      async (uri, { id }) => {
        const result = await getTask(String(id), currentUser());
        return json(uri.href, result ?? { error: "Task not found" });
      },
    );

    /* ----------------------------------------------------------------- */
    /* PROMPTS — board-aware slash commands (pre-filled with your data).  */
    /* ----------------------------------------------------------------- */

    server.registerPrompt(
      "plan_my_day",
      {
        title: "Plan my day",
        description: "Turn today's tasks into a prioritized plan.",
      },
      async () => {
        const today = toMarkdown(await listToday(currentUser()), await userNameMap());
        return await promptMsg(
          `Here is my board for today (in-progress, planned, and anything due or overdue):\n\n${today}\n\n` +
            `Please propose a prioritized plan for today: what to do first and why, what to defer, and any risks or blockers. ` +
            `If I approve, you can reorder or restage tasks with the move_task and update_task tools.`,
        );
      },
    );

    server.registerPrompt(
      "triage_backlog",
      {
        title: "Triage backlog",
        description: "Propose priorities and due dates for backlog items.",
      },
      async () => {
        const backlog = (await listTasksFlat(currentUser())).filter(
          (t) => t.status === "backlog",
        );
        const body = backlog.length
          ? toMarkdown(backlog, await userNameMap())
          : "_(backlog is empty)_";
        return await promptMsg(
          `Here is my backlog:\n\n${body}\n\n` +
            `Please triage it: for each task suggest a value/difficulty and a due date where it makes sense, ` +
            `and flag anything that should be dropped or promoted to Planned. ` +
            `If I approve, apply your suggestions with the update_task tool (and move_task to promote).`,
        );
      },
    );

    server.registerPrompt(
      "weekly_review",
      {
        title: "Weekly review",
        description:
          "Summarize what got done this week and what's gone stale.",
      },
      async () => {
        const all = await listTasksFlat(currentUser());
        const names = await userNameMap();
        const done = all.filter(
          (t) => t.status === "done" && daysAgo(t.statusSince) <= 7,
        );
        const stale = all.filter(
          (t) => t.status === "backlog" && daysAgo(t.createdAt) >= 14,
        );
        const section = (label: string, tasks: typeof all) =>
          `## ${label}\n\n${tasks.length ? toMarkdown(tasks, names) : "_(none)_"}`;
        return await promptMsg(
          `${section("Completed in the last 7 days", done)}\n\n` +
            `${section("Stale backlog (untouched 14+ days)", stale)}\n\n` +
            `Please write a short weekly review: what I accomplished, what's stalled and why it might be, ` +
            `and 3–5 concrete next steps for the coming week.`,
        );
      },
    );

    server.registerPrompt(
      "breakdown_task",
      {
        title: "Break down a task",
        description: "Propose subtasks for a single task.",
        argsSchema: { taskId: z.string() },
      },
      async ({ taskId }) => {
        const result = await getTask(taskId, currentUser());
        if (!result)
          return await promptMsg(
            `Task ${taskId} was not found on my board. Please ask me to pick a valid task id.`,
          );
        return await promptMsg(
          titleHeader(result.task.title) +
            `Here is a task I'd like to break down:\n\n${JSON.stringify(result.task, null, 2)}\n\n` +
            `Please propose a set of concrete subtasks that would complete it, in a sensible order. ` +
            `If I approve, create them with the create_task tool using parentId: "${taskId}".`,
        );
      },
    );

    /* ----------------------------------------------------------------- */
    /* WORKFLOW PROMPTS — the handoff + finish protocol, board-aware.     */
    /* work_on_task LOCKS the code so it's citable in commits.            */
    /* ----------------------------------------------------------------- */

    server.registerPrompt(
      "work_on_task",
      {
        title: "Work on a task",
        description:
          "Hand a task to the AI: locks its code, then loads full context + the workflow protocol.",
        argsSchema: { taskId: z.string() },
      },
      async ({ taskId }) => {
        // Handoff: lock the code so every commit can cite it, then load context.
        const locked = await mintRef(taskId, currentUser(), AI_AUTHOR);
        const result = await getTask(taskId, currentUser());
        if (!locked || !result)
          return await promptMsg(
            `Task ${taskId} was not found on my board. Please ask me to pick a valid task id or code.`,
          );
        const code = result.task.code ?? taskId;
        // Attachments are images someone added BECAUSE the words weren't enough.
        // The JSON only carries their metadata, so say out loud that they must be
        // fetched — an `attachments` key buried in a large dump gets skimmed past.
        const atts = result.task.attachments ?? [];
        const seeImages = atts.length
          ? `This task has ${atts.length} image${atts.length > 1 ? "s" : ""} attached — ` +
            `part of the brief, not decoration. Call \`get_attachment\` on each of these ` +
            `ids and actually look at them BEFORE you analyze or plan:\n` +
            atts.map((a) => `- \`${a.id}\` — ${a.filename}`).join("\n") +
            `\n\n`
          : "";
        return await promptMsg(
          titleHeader(result.task.title) +
            `I want you to work on task **${code}** (id: ${taskId}).\n\n` +
            `Here it is:\n\n${JSON.stringify(result.task, null, 2)}\n\n` +
            seeImages +
            `Follow the todo workflow contract (in your server instructions / the ` +
            `\`todo://workflow\` resource) using the todo MCP tools — read it if you ` +
            `haven't. Start by understanding the task and the relevant code, and ask ` +
            `me anything unclear before deciding.`,
        );
      },
    );

    server.registerPrompt(
      "finish_task",
      {
        title: "Finish a task",
        description:
          "Write a short summary of what actually shipped (you can diff git to help), then ask before marking done.",
        argsSchema: { taskId: z.string() },
      },
      async ({ taskId }) => {
        const result = await getTask(taskId, currentUser());
        if (!result)
          return await promptMsg(
            `Task ${taskId} was not found. Please ask me to pick a valid task id or code.`,
          );
        const t = result.task;
        const since = t.lockedAt ?? t.createdAt;
        return await promptMsg(
          titleHeader(t.title) +
            `Let's finish task **${t.code ?? taskId}** (id: ${taskId}).\n\n` +
            `Recorded analysis:\n${t.analysisSummary ?? "_(none)_"}\n\n` +
            `Recorded plan:\n${t.plan ?? "_(none)_"}\n\n` +
            `Run the **Finish** step of the todo workflow contract (in your server ` +
            `instructions / the \`todo://workflow\` resource): write a short ` +
            `\`summary\` of what actually shipped — you can diff git since${
              since ? ` (~${since})` : ""
            } (or the branch point) and compare against the analysis + plan above ` +
            `to help. Add the context the diff can't show — the why, key decisions, ` +
            `gotchas, follow-ups — and give any scope added along the way its own ` +
            `line. Keep it concise. Then ask me "Can I mark this as done?" and ` +
            `only complete_task once I confirm — never just because the code is ` +
            `written; I may want to view or visually check something first.`,
        );
      },
    );

    server.registerPrompt(
      "finish_work",
      {
        title: "Finish work",
        description:
          "Walk the end-of-day close-out for a project and write the standup.",
        argsSchema: { projectId: z.string(), day: z.string() },
      },
      async ({ projectId, day }) => {
        const review = await workDayReview(currentUser(), projectId, day);
        return await promptMsg(
          `Let's close out ${day}. Here's the raw material:\n\n` +
            `${JSON.stringify(
              {
                day: review.day,
                candidates: review.candidates.map((t) => ({
                  ref: t.code,
                  title: t.title,
                  status: t.status,
                })),
                shipped: review.digest.shipped.map((e) => ({
                  ref: e.task.code,
                  title: e.task.title,
                })),
                handled: review.digest.handled.map((e) => ({
                  ref: e.task.code,
                  title: e.task.title,
                })),
                worked: review.digest.worked.map((e) => ({
                  ref: e.task.code,
                  title: e.task.title,
                  stints: e.stints,
                })),
                closedUnattributed: review.digest.closedUnattributed.map((c) => ({
                  ref: c.task.code,
                  title: c.task.title,
                })),
                drift: review.drift,
                openDays: review.openDays,
              },
              null,
              2,
            )}\n\n` +
            `Now run the **Finish work** flow from the \`DAY_CLOSE\` contract in ` +
            `your server instructions, in order:\n\n` +
            `0. If \`openDays\` isn't empty, say so first and ask whether to close ` +
            `those out before this one — they're days whose work never made it ` +
            `into any standup.\n` +
            `1. Ask me which of the \`candidates\` actually finished — one at a ` +
            `time, each with its own \`summary\`, each through \`complete_task\` ` +
            `once I confirm. Never bulk-complete them.\n` +
            `2. Ask me what I did that ISN'T here — calls, conversations, ` +
            `errands. Anything I name goes in via \`log_past_work\` dated ${day}.\n` +
            `3. Flag anything whose date looks wrong.\n` +
            `4. Write the standup in the shape the contract specifies and save it ` +
            `with \`finish_work\`. If \`drift.doneNotPlanned\` isn't empty, give ` +
            `the interruptions a line — that's usually the most honest part of ` +
            `the update.`,
        );
      },
    );

    server.registerPrompt(
      "standup_report",
      {
        title: "Standup",
        description: "A shareable standup digest for a recent window.",
        argsSchema: { from: z.string(), to: z.string() },
      },
      async ({ from, to }) => {
        const digest = await activityDigest(currentUser(), {
          from,
          to,
          credited: currentUser(),
        });
        return await promptMsg(
          `Here's the raw material for a standup covering ${from} → ${to}:\n\n` +
            `${JSON.stringify(digest, null, 2)}\n\n` +
            `Please write a concise, shareable standup update from the tasks themselves — their summaries are what shipped. List what shipped (one line each), and keep \`handled\` items separate from \`shipped\` ones — say "handled", never "built". Say what's still in flight, and flag anything that looks stuck. Mention \`closedUnattributed\` as tasks cleared off the board, never as someone's work. Keep it tight enough to paste into a team channel.`,
        );
      },
    );
    server.registerPrompt(
      "clean_up_todo",
      {
        title: "Clean up the todo",
        description:
          "Reconcile what the board claims against what the code shows, then propose.",
        argsSchema: { projectId: z.string(), boardId: z.string().optional() },
      },
      async ({ projectId, boardId }) => {
        const review = await boardReview(currentUser(), {
          ...(projectId ? { projectId } : {}),
          ...(boardId ? { boardId } : {}),
        });
        const line = (r: (typeof review.tasks)[number]) => ({
          ref: r.task.code,
          id: r.task.id,
          title: r.task.title,
          status: r.task.status,
          placement: r.placement,
          why: r.why,
          daysInStatus: r.daysInStatus,
          daysSinceActivity: r.daysSinceActivity,
          has: r.has,
          commitCount: r.commitCount,
          updatedAt: r.task.updatedAt,
          events: r.events,
          logs: r.logs,
          commits: r.commits.map((c) => ({ sha: c.sha, subject: c.subject })),
          flags: r.flags,
        });
        return await promptMsg(
          `Let's clean up the todo for **${review.scope.projectName ?? projectId}**` +
            `${review.scope.boardName ? ` → ${review.scope.boardName}` : ""}. ` +
            `Here's the board's state, worst-first:\n\n` +
            `${JSON.stringify(
              {
                scope: review.scope,
                window: { from: review.from, to: review.to },
                thresholds: review.thresholds,
                caveats: review.caveats,
                writeUps: review.writeUps,
                total: review.total,
                tasks: review.tasks.map(line),
                elsewhere: review.elsewhere,
              },
              null,
              2,
            )}\n\n` +
            `Now run the **Cleaning up the board** flow from the \`BOARD_CLEANUP\` ` +
            `contract in your server instructions (or the \`todo://cleanup\` ` +
            `resource), in order:\n\n` +
            `1. Read the \`caveats\` and \`flags\` first, and work the tasks in the ` +
            `order given — they're sorted by how much they need attention.\n` +
            `2. For each one, **read the code**: \`git log\` since it entered its ` +
            `current status, the diff, the actual files it's about. ` +
            `\`get_task\` for the full brief (\`has\` only gives you field ` +
            `lengths) and \`get_attachment\` on every image before you conclude ` +
            `anything. Never infer where code lives from another task's plan or ` +
            `summary.\n` +
            `3. If this project's code isn't on this machine ` +
            `(\`scope.gitFolder\` is ${review.scope.gitFolder ? `\`${review.scope.gitFolder}\`` : "**null** — nobody recorded it"}), ` +
            `say so and stick to board hygiene. Never claim what the code does ` +
            `from a board read.\n` +
            `4. Give me **one table**: ref · title · status/placement · days idle ` +
            `· what the board claims · what the code shows · what you propose ` +
            `(complete / to review / back to building / re-file / split / write ` +
            `the plan / write the summary / link commits / no change / ask me) · ` +
            `the evidence for it (a file, a commit, "nothing since the 18th").\n` +
            `5. Then ask me. One at a time for anything that completes or closes ` +
            `a task — each through \`complete_task\` with its own \`summary\`. ` +
            `Batch the filing moves as a single question.\n` +
            `6. Apply only what I approve, passing \`expectedUpdatedAt\` on every ` +
            `\`update_task\`. Don't resolve my \`review\` notes.\n` +
            `7. Tell me what you deliberately left alone, and why. If the board ` +
            `is already honest, say so — don't invent a tidy-up to justify the pass.`,
        );
      },
    );

  },
  {
    // The three canonical contracts, delivered to every client on connect: one
    // task's journey, then one day's record, then the board's state.
    instructions: `${WORKFLOW}\n\n${DAY_CLOSE}\n\n${BOARD_CLEANUP}`,
  },
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: process.env.NODE_ENV !== "production",
  },
);

/** Resolve the token → user, then run the handler scoped to that user. */
async function authed(req: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    throw e;
  }
  // MCP requests are attributed to the token's owner, acting "via Claude".
  return userStore.run(userId, () =>
    withLogContext({ actorId: userId, source: "mcp" }, () => handler(req)),
  );
}

export { authed as GET, authed as POST, authed as DELETE };
