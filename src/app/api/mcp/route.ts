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
      https://<your-app>.vercel.app/api/mcp \
      --header "Authorization: Bearer <your-personal-token>"
  ====================================================================
*/

import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler } from "mcp-handler";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireUser, AuthError } from "@/lib/auth";
import { ConflictError, bulkOpSchema, updateTaskSchema } from "@/lib/api";
import { daysAgo } from "@/lib/format";
import {
  listTasks,
  listTasksFlat,
  listToday,
  getTask,
  createTask,
  updateTask,
  moveTask,
  completeTask,
  addComment,
  deleteTask,
  bulkUpdate,
  bulkApply,
  getAttachmentById,
  toMarkdown,
} from "@/lib/db/service";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  CalendarError,
} from "@/lib/google/calendar";
import { listPublicConnections } from "@/lib/google/connections";

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

const statusEnum = z.enum(["backlog", "planned", "in-progress", "done"]);
const recurrenceEnum = z.enum(["none", "daily", "weekly", "monthly"]);
/** Fibonacci points for value (payoff) and difficulty (effort). */
const fibEnum = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
]);
const assigneesArg = z.array(z.string().max(120)).max(20);
const dependsOnArg = z.array(z.string()).max(50);
const customFieldsArg = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

/** MCP-authored changes are attributed to "Claude" in the activity log. */
const AI_AUTHOR = "Claude";

const text = (data: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    },
  ],
});

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

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "list_tasks",
      "List every task on the board. Returns the full nested tree with stable ids, statuses, assignees, start/due dates, tags, value/difficulty points, recurrence, dependencies and subtasks. Use format:'markdown' for a compact, skimmable view.",
      { format: z.enum(["json", "markdown"]).optional().default("json") },
      async ({ format }) => {
        const tree = await listTasks(currentUser());
        return text(format === "markdown" ? toMarkdown(tree) : { tasks: tree });
      },
    );

    server.tool(
      "get_task",
      "Get one task by id, including its full activity log and comments.",
      { id: z.string() },
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
      "Create a new task. Only `title` is required. Status defaults to backlog. `value` and `difficulty` are Fibonacci points (1/2/3/5/8). Pass parentId to create it as a subtask.",
      {
        title: z.string().min(1).max(500),
        status: statusEnum.optional(),
        assignees: assigneesArg.optional(),
        startDate: ymd.optional(),
        dueDate: ymd.optional(),
        recurrence: recurrenceEnum.optional(),
        dependsOn: dependsOnArg.optional(),
        customFields: customFieldsArg.optional(),
        value: fibEnum.optional(),
        difficulty: fibEnum.optional(),
        description: z.string().max(10_000).optional(),
        tags: z.array(z.string()).optional(),
        parentId: z.string().optional(),
      },
      async (input) =>
        text({ task: await createTask(input, currentUser(), AI_AUTHOR) }),
    );

    server.tool(
      "update_task",
      "Update fields on an existing task. Only the fields you pass change. Pass null to clear a nullable field (startDate, dueDate, value, difficulty, description). Pass an empty array to clear assignees/dependsOn/tags.",
      {
        id: z.string(),
        title: z.string().min(1).max(500).optional(),
        status: statusEnum.optional(),
        assignees: assigneesArg.optional(),
        startDate: ymd.nullable().optional(),
        dueDate: ymd.nullable().optional(),
        recurrence: recurrenceEnum.optional(),
        dependsOn: dependsOnArg.optional(),
        customFields: customFieldsArg.optional(),
        value: fibEnum.nullable().optional(),
        difficulty: fibEnum.nullable().optional(),
        description: z.string().max(10_000).nullable().optional(),
        tags: z.array(z.string()).optional(),
        expectedUpdatedAt: z
          .string()
          .optional()
          .describe(
            "Optional optimistic-lock token: the task's updatedAt from your last read. If provided and the task changed since, the update is rejected as a conflict.",
          ),
      },
      async ({ id, expectedUpdatedAt, ...patch }) => {
        try {
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
      "Reorder or re-nest a task: change its status (move between groups), parentId (nest under another task, or null for top level), and/or position.",
      {
        id: z.string(),
        status: statusEnum.optional(),
        parentId: z.string().nullable().optional(),
        position: z.number().optional(),
      },
      async ({ id, ...target }) => {
        const task = await moveTask(id, target, currentUser(), AI_AUTHOR);
        return task ? text({ task }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "complete_task",
      "Mark a task done (default), or reopen it with done:false (sends it back to Planned).",
      { id: z.string(), done: z.boolean().optional().default(true) },
      async ({ id, done }) => {
        const task = await completeTask(id, done, currentUser(), AI_AUTHOR);
        return task ? text({ task }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "add_comment",
      "Add a note/comment to a task's activity log.",
      { id: z.string(), message: z.string().min(1).max(10_000) },
      async ({ id, message }) => {
        const comment = await addComment(id, message, currentUser(), AI_AUTHOR);
        return comment ? text({ comment }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "delete_task",
      "Delete a task. Its subtasks are re-parented to the top level (not deleted).",
      { id: z.string() },
      async ({ id }) => text({ ok: await deleteTask(id, currentUser()) }),
    );

    server.tool(
      "bulk_update",
      "Apply the SAME change to many tasks at once — the efficient path for edits like 'assign these to Simon', 'tag these #work', or 'move these to Planned'. `patch` accepts the same fields as update_task (null clears a nullable field; an empty array clears assignees/dependsOn/tags). Tasks you don't own are silently skipped and returned in `skipped`.",
      { ids: z.array(z.string()).min(1).max(500), patch: updateTaskSchema },
      async ({ ids, patch }) =>
        text(await bulkUpdate(currentUser(), ids, patch, AI_AUTHOR)),
    );

    server.tool(
      "bulk_apply",
      "Run an ORDERED list of mixed operations in one call — the power tool for real reorganization (build a roadmap, move some, complete a sprint). Each op is one of create/update/move/complete/comment/delete. Best-effort: a failing op is reported in `results` and the batch continues, so partial failure is visible. Capped at 200 ops (extra are dropped and flagged via `truncated`).",
      { operations: z.array(bulkOpSchema).min(1) },
      async ({ operations }) =>
        text(await bulkApply(currentUser(), operations, AI_AUTHOR)),
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
      async (uri) => md(uri.href, toMarkdown(await listTasks(currentUser()))),
    );

    server.registerResource(
      "board-json",
      "todo://board.json",
      {
        title: "My board (JSON)",
        description:
          "Full nested task tree with ids, statuses, dates, points, subtasks.",
        mimeType: "application/json",
      },
      async (uri) => json(uri.href, { tasks: await listTasks(currentUser()) }),
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
      async (uri) => md(uri.href, toMarkdown(await listToday(currentUser()))),
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
        const today = toMarkdown(await listToday(currentUser()));
        return userMsg(
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
          ? toMarkdown(backlog)
          : "_(backlog is empty)_";
        return userMsg(
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
        const done = all.filter(
          (t) => t.status === "done" && daysAgo(t.statusSince) <= 7,
        );
        const stale = all.filter(
          (t) => t.status === "backlog" && daysAgo(t.createdAt) >= 14,
        );
        const section = (label: string, tasks: typeof all) =>
          `## ${label}\n\n${tasks.length ? toMarkdown(tasks) : "_(none)_"}`;
        return userMsg(
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
          return userMsg(
            `Task ${taskId} was not found on my board. Please ask me to pick a valid task id.`,
          );
        return userMsg(
          `Here is a task I'd like to break down:\n\n${JSON.stringify(result.task, null, 2)}\n\n` +
            `Please propose a set of concrete subtasks that would complete it, in a sensible order. ` +
            `If I approve, create them with the create_task tool using parentId: "${taskId}".`,
        );
      },
    );
  },
  {
    // Server metadata / capabilities (defaults are fine).
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
  return userStore.run(userId, () => handler(req));
}

export { authed as GET, authed as POST, authed as DELETE };
