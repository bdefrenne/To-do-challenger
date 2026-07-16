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
  searchTasks,
  getTask,
  startAnalysis,
  startWork,
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
  listProjects,
  createProject,
  updateProject,
  createBoard,
  updateBoard,
  mintRef,
  recordDecision,
  listDecisions,
  reviewDecision,
  addNote,
  listNotes,
  linkCommit,
  standup,
} from "@/lib/db/service";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  CalendarError,
} from "@/lib/google/calendar";
import { listPublicConnections } from "@/lib/google/connections";
import { SYNC_NOTE } from "@/lib/repo-sync";
import { WORKFLOW } from "@/lib/workflow";

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
const isoDateTime = z.string().min(1).max(40);
const decisionCategoryEnum = z.enum([
  "business",
  "product",
  "ux",
  "technical",
  "scope",
]);
const decisionOutcomeEnum = z.enum(["good", "mixed", "bad"]);
const noteTypeEnum = z.enum(["progress", "blocker", "question", "fyi"]);

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
      "List every task on the board. Returns the full nested tree with stable ids, statuses, assignees, start/due dates, value/difficulty points, recurrence, dependencies and subtasks. Use format:'markdown' for a compact, skimmable view.",
      { format: z.enum(["json", "markdown"]).optional().default("json") },
      async ({ format }) => {
        const tree = await listTasks(currentUser());
        return text(format === "markdown" ? toMarkdown(tree) : { tasks: tree });
      },
    );

    server.tool(
      "get_task",
      "Passive PEEK at a task: its headline fields + its direct subtasks (one level: id/code/title/status etc.) + activity log/comments + counts of decisions/notes/commits — enough to check status or locate a task. It does NOT return the working context (recorded decisions, notes, linked commits, board gitFolder, phase playbook) and does NOT record that you've started. ⚠️ If you are about to ANALYZE or BUILD this task, do NOT use this — call `get_task_for_analysis` or `get_task_for_working`: they return the FULL context you need AND stamp the start. Only the phase tools give you the working context, so there's no way to \"just read everything\" without recording that you began.",
      { id: z.string() },
      async ({ id }) => {
        const result = await getTask(id, currentUser());
        if (!result) return text({ error: "Task not found" });
        return text({
          task: result.task,
          activity: result.logs, // includes comments (kind:"comment")
          counts: {
            decisions: result.decisions.length,
            notes: result.notes.length,
            commits: result.commits.length,
          },
          hint: "Lean peek. To analyze or build this task, call get_task_for_analysis or get_task_for_working — they return the full context and record the start.",
        });
      },
    );

    server.tool(
      "get_task_for_analysis",
      "START HERE to analyze a task — the required entry point before any analysis. Returns the FULL task context (description, activity, prior decisions, notes, commits) so you can understand it, locks the code so commits can cite it, and records that analysis has started (stamps `analysisStartedAt` the first time + an attributed activity entry). Then follow the Analyze step of the todo workflow. When you move from analysis to building, call `get_task_for_working`. Use plain `get_task` only for a passive status check you don't intend to act on.",
      { id: z.string() },
      async ({ id }) => {
        const result = await startAnalysis(id, currentUser(), AI_AUTHOR);
        if (!result) return text({ error: "Task not found" });
        return text({
          ...result,
          next: "Analyze: record_decision for EACH choice (business/product/ux/technical/scope). Read the container's description + gitFolder via list_projects if it's on a project/board. When analysis is settled, set analysisSummary + analyzedAt. To start building, call get_task_for_working.",
        });
      },
    );

    server.tool(
      "get_task_for_working",
      "START HERE to build/implement a task, after analysis — the required entry point before any coding. Returns the FULL working context (the plan, all recorded decisions to implement, notes, linked commits, and the locked code to cite) and records that work has started (stamps `workStartedAt` the first time + an attributed activity entry). If you haven't analyzed yet, call `get_task_for_analysis` first. Use plain `get_task` only for a passive status check.",
      { id: z.string() },
      async ({ id }) => {
        const result = await startWork(id, currentUser(), AI_AUTHOR);
        if (!result) return text({ error: "Task not found" });
        return text({
          ...result,
          next: "Work: reference the locked code in EVERY commit message and link_commit each sha; log anything added on the fly as a `scope` decision. Run the finish_task protocol (reconcile the git diff, write the summary, mark done) when finished.",
        });
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
      "Create a new task. Only `title` is required. Status defaults to backlog. `value` and `difficulty` are Fibonacci points (1/2/3/5/8). Pass parentId to create it as a subtask, or boardId to file it onto a specific board (see list_projects).",
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
        parentId: z.string().optional(),
        boardId: z.string().nullable().optional(),
      },
      async (input) =>
        text({ task: await createTask(input, currentUser(), AI_AUTHOR) }),
    );

    server.tool(
      "update_task",
      "Update fields on an existing task. Only the fields you pass change. Pass null to clear a nullable field (startDate, dueDate, value, difficulty, description). Pass an empty array to clear assignees/dependsOn. WORKFLOW: write the revisable summaries here — `analysisSummary` when analysis is done (also set `analyzedAt`), `plan` when you start building, and `summary` at the end (see the finish_task prompt: reconcile against the git diff, don't just recollect). Set lifecycle timestamps (`analyzedAt` etc.) to the current time as an ISO string when the corresponding milestone is reached; you rarely set the START stamps by hand — `analysisStartedAt` fires when you call `get_task_for_analysis` (or the work_on_task prompt), `workStartedAt` when you call `get_task_for_working`, with record_decision/link_commit as set-if-null backstops.",
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
        analysisSummary: z.string().max(20_000).nullable().optional(),
        plan: z.string().max(20_000).nullable().optional(),
        summary: z.string().max(20_000).nullable().optional(),
        analysisStartedAt: isoDateTime.nullable().optional(),
        analyzedAt: isoDateTime.nullable().optional(),
        workStartedAt: isoDateTime.nullable().optional(),
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
      "Reorder, re-nest, or re-file a task: change its status (move between groups), parentId (nest under another task, or null for top level), boardId (move onto a board, or null to unassign — see list_projects), and/or position.",
      {
        id: z.string(),
        status: statusEnum.optional(),
        parentId: z.string().nullable().optional(),
        boardId: z.string().nullable().optional(),
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
      "search_tasks",
      "Query your tasks by any combination of filters — PREFER this over list_tasks for targeted questions like 'what's overdue?', 'urgent work tasks', or 'what's assigned to Simon?'. All filters are optional and AND together. Returns a flat list.",
      {
        status: z.array(statusEnum).optional(),
        assignee: z.string().max(120).optional().describe("matches one of a task's assignees"),
        text: z.string().max(200).optional().describe("substring of title or description"),
        dueBefore: ymd.optional(),
        dueAfter: ymd.optional(),
        overdue: z.boolean().optional().describe("past due and not done"),
        boardId: z.string().optional(),
        projectId: z.string().optional(),
        format: z.enum(["json", "markdown"]).optional().default("json"),
      },
      async ({ format, ...filter }) => {
        const result = await searchTasks(currentUser(), filter);
        return text(
          format === "markdown"
            ? toMarkdown(result)
            : { count: result.length, tasks: result },
        );
      },
    );

    /* ----------------------------------------------------------------- */
    /* WORKFLOW — the process layer: lock the code, record decisions +    */
    /* notes as they happen, link commits. See work_on_task / finish_task */
    /* prompts for the protocol. All auto-fire lifecycle timestamps.      */
    /* ----------------------------------------------------------------- */

    server.tool(
      "lock_task",
      "Lock (freeze) a task's human code so it's stable to cite in commits — e.g. GH-20* becomes GH-20. Idempotent: locking an already-locked task just returns it. Normally you don't call this directly — the work_on_task prompt locks on handoff — but call it if you're about to commit work referencing a task whose code is still soft (ends with *).",
      { id: z.string() },
      async ({ id }) => {
        const task = await mintRef(id, currentUser());
        return task ? text({ task }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "record_decision",
      "Record a decision made while working a task — LOG EACH ONE AS IT HAPPENS, not saved up for the end. `category` is one of business/product/ux/technical/scope (use `scope` for capabilities you added on the fly that never got their own task — this is how scope-creep stays visible). The first decision auto-starts the analysis clock. Decisions are queryable across all tasks (see list_decisions) and reviewed later for outcome.",
      {
        id: z.string(),
        category: decisionCategoryEnum,
        decision: z.string().min(1).max(2_000),
        rationale: z.string().max(10_000).optional(),
      },
      async ({ id, category, decision, rationale }) => {
        const d = await recordDecision(
          id,
          { category, decision, rationale },
          currentUser(),
          AI_AUTHOR,
        );
        return d ? text({ decision: d }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "list_decisions",
      "Query decisions ACROSS all your tasks — filter by category, board, project, date range, or unreviewed-only. Use for retros ('review our technical decisions') and audits. All filters optional and AND together.",
      {
        taskId: z.string().optional(),
        category: decisionCategoryEnum.optional(),
        boardId: z.string().optional(),
        projectId: z.string().optional(),
        unreviewed: z.boolean().optional().describe("only decisions with no outcome yet"),
        from: z.string().max(40).optional().describe("lower bound (ISO/date, inclusive)"),
        to: z.string().max(40).optional().describe("upper bound (ISO/date, inclusive)"),
      },
      async (filter) => {
        const decisions = await listDecisions(currentUser(), filter);
        return text({ count: decisions.length, decisions });
      },
    );

    server.tool(
      "review_decision",
      "Fill in a decision's retro verdict — was it good? `outcome` is good/mixed/bad, with an optional note. Use after list_decisions surfaces the ones worth grading.",
      {
        id: z.string(),
        outcome: decisionOutcomeEnum,
        reviewNote: z.string().max(10_000).optional(),
      },
      async ({ id, outcome, reviewNote }) => {
        const d = await reviewDecision(id, { outcome, reviewNote }, currentUser());
        return d ? text({ decision: d }) : text({ error: "Decision not found" });
      },
    );

    server.tool(
      "add_note",
      "Add a team-facing note to a task — the raw material for standup. Use whenever something standup-worthy happens: a blocker, a milestone, a question for the team. `type` is progress/blocker/question/fyi (drives how the standup digest groups it).",
      {
        id: z.string(),
        note: z.string().min(1).max(10_000),
        type: noteTypeEnum.optional(),
      },
      async ({ id, note, type }) => {
        const n = await addNote(id, { note, type }, currentUser(), AI_AUTHOR);
        return n ? text({ note: n }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "list_notes",
      "Query team notes ACROSS all your tasks — filter by task, type, or date range. Powers the standup digest.",
      {
        taskId: z.string().optional(),
        type: noteTypeEnum.optional(),
        from: z.string().max(40).optional(),
        to: z.string().max(40).optional(),
      },
      async (filter) => {
        const notes = await listNotes(currentUser(), filter);
        return text({ count: notes.length, notes });
      },
    );

    server.tool(
      "link_commit",
      "Record a git commit against a task so the task page lists what shipped it. Pass the `sha` (and ideally the `subject` line). Idempotent per (task, sha). The first linked commit auto-starts the work clock. Commit messages should reference the task's locked code, e.g. `[GH-20] …`.",
      {
        id: z.string(),
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
      "Assemble a standup digest for a date window: team notes (grouped by type), tasks finished in the window with their summaries, and decisions made. Dates are ISO/YYYY-MM-DD (inclusive).",
      {
        from: z.string().min(1).max(40).describe("start of window (inclusive)"),
        to: z.string().min(1).max(40).describe("end of window (inclusive)"),
      },
      async ({ from, to }) => text(await standup(currentUser(), from, to)),
    );

    /* ----------------------------------------------------------------- */
    /* PROJECTS & BOARDS — so the AI can see + shape the hierarchy and    */
    /* file tasks onto the right board (deletes omitted on purpose).      */
    /* ----------------------------------------------------------------- */

    server.tool(
      "list_projects",
      `List your projects, each with its boards. Every project AND board includes: \`id\`, \`name\`, \`code\` (its ≤4-char shortname / ref prefix, e.g. "GH"), \`color\` (hex), \`image\` (picture URL or null), \`gitFolder\` (the path to its git working directory — where its code lives on disk, or null if unset), and \`description\` (a Markdown readme explaining what it is and its constraints, or null). READ each \`description\` and \`gitFolder\` first to understand what a project/board is about and where its code lives before working on its tasks. ${SYNC_NOTE} Use a board \`id\` as the \`boardId\` when creating or moving tasks to file them under the right board.`,
      {},
      async () => text({ projects: await listProjects(currentUser()) }),
    );

    server.tool(
      "create_project",
      "Create a new project (a top-level container for boards). Besides the name you can set: `code` (the project's ≤4-char shortname / ref prefix, used for tasks scoped to the project but no board; auto-derived from the name if omitted), `color` (#rrggbb hex accent), `image` (a public picture URL), `gitFolder` (the path to the project's git working directory — where its code lives), and `description` (a Markdown readme explaining what the project is, its purpose, and constraints). ALWAYS write a `description` so that AIs without access to the code can understand the project.",
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
      },
      async ({ name, code, color, image, gitFolder, description }) =>
        text({
          project: await createProject(currentUser(), name, {
            code,
            color,
            image,
            gitFolder,
            description,
          }),
        }),
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
      "bulk_update",
      "Apply the SAME change to many tasks at once — the efficient path for edits like 'assign these to Simon', 'move these to Planned', or 'set these to done'. `patch` accepts the same fields as update_task (null clears a nullable field; an empty array clears assignees/dependsOn). Tasks you don't own are silently skipped and returned in `skipped`.",
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
        // Handoff = enter the analysis phase: locks the code, stamps
        // analysisStartedAt (set-if-null), and logs a `started` activity entry.
        // Same server op the get_task_for_analysis tool uses, so both surfaces
        // record the start identically.
        const result = await startAnalysis(taskId, currentUser(), "You");
        if (!result)
          return userMsg(
            `Task ${taskId} was not found on my board. Please ask me to pick a valid task id or code.`,
          );
        const code = result.task.code ?? taskId;
        return userMsg(
          `I want you to work on task **${code} — ${result.task.title}** (id: ${taskId}).\n\n` +
            `Here it is:\n\n${JSON.stringify(result.task, null, 2)}\n\n` +
            `Follow the todo workflow contract (in your server instructions / the ` +
            `\`todo://workflow\` resource) using the todo MCP tools — read it if you ` +
            `haven't. Analysis has started and its code is locked, so reference ` +
            `**${code}** in every commit and \`link_commit\` each sha. Start by ` +
            `understanding the task and the relevant code, and ask me anything ` +
            `unclear before deciding. When you move from analysis to building, call ` +
            `\`get_task_for_working\` to load the build context and record it.`,
        );
      },
    );

    server.registerPrompt(
      "finish_task",
      {
        title: "Finish a task",
        description:
          "Reconcile what actually shipped against the git diff (not memory), write the summary, mark done.",
        argsSchema: { taskId: z.string() },
      },
      async ({ taskId }) => {
        const result = await getTask(taskId, currentUser());
        if (!result)
          return userMsg(
            `Task ${taskId} was not found. Please ask me to pick a valid task id or code.`,
          );
        const t = result.task;
        const since = t.workStartedAt ?? t.analyzedAt ?? t.analysisStartedAt;
        return userMsg(
          `Let's finish task **${t.code ?? taskId} — ${t.title}** (id: ${taskId}).\n\n` +
            `Recorded plan:\n${t.plan ?? "_(none)_"}\n\n` +
            `Recorded decisions:\n${
              result.decisions.length
                ? result.decisions
                    .map((d) => `- [${d.category}] ${d.decision}`)
                    .join("\n")
                : "_(none)_"
            }\n\n` +
            `Run the **Finish** step of the todo workflow contract (in your server ` +
            `instructions / the \`todo://workflow\` resource): reconcile, don't ` +
            `recollect. Diff git since work started${since ? ` (~${since})` : ""} ` +
            `(or the branch point), compare against the plan + decisions above, and ` +
            `write the \`summary\` from what ACTUALLY shipped. Make sure every commit ` +
            `referenced **${t.code ?? taskId}**.`,
        );
      },
    );

    server.registerPrompt(
      "review_decisions",
      {
        title: "Review decisions",
        description: "Grade past decisions (were they good?) — a retro pass.",
      },
      async () => {
        const decisions = await listDecisions(currentUser(), { unreviewed: true });
        const body = decisions.length
          ? decisions
              .map(
                (d) =>
                  `- \`${d.id}\` [${d.category}] ${d.decision}${d.rationale ? ` — ${d.rationale}` : ""}`,
              )
              .join("\n")
          : "_(no unreviewed decisions)_";
        return userMsg(
          `Here are decisions still awaiting a verdict:\n\n${body}\n\n` +
            `For each, assess how it actually turned out against the current code and outcomes, then record a verdict with \`review_decision\` (outcome good/mixed/bad + a short note). Flag any that were later reversed.`,
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
        const data = await standup(currentUser(), from, to);
        return userMsg(
          `Here's the raw material for a standup covering ${from} → ${to}:\n\n` +
            `${JSON.stringify(data, null, 2)}\n\n` +
            `Please write a concise, shareable standup update: group notes into **Progress**, **Blockers**, and **Questions**; list what shipped (finished tasks + one-line summaries); and call out any notable decisions. Keep it tight enough to paste into a team channel.`,
        );
      },
    );
  },
  {
    // The canonical workflow contract, delivered to every client on connect.
    instructions: WORKFLOW,
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
