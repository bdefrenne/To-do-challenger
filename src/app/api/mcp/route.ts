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
import { ConflictError, bulkOpSchema, updateTaskSchema } from "@/lib/api";
import { daysAgo } from "@/lib/format";
import {
  listTasks,
  listTasksFlat,
  listToday,
  searchTasks,
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
  addNote,
  listNotes,
  resolveNote,
  linkCommit,
  standup,
  listCanvases,
  getCanvas,
  createCanvas,
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
import { WORKFLOW } from "@/lib/workflow";
import { langSuffix } from "@/lib/prompts";

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
  "done",
]);
const recurrenceEnum = z.enum(["none", "daily", "weekly", "monthly"]);
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
const noteTypeEnum = z.enum([
  "decision",
  "progress",
  "milestone",
  "blocker",
  "question",
  "fyi",
  "review",
]);

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
      "List every task on the board. Returns the full nested tree with stable ids, statuses, assignees, start/due dates, value/difficulty points, recurrence, dependencies and subtasks. Use format:'markdown' for a compact, skimmable view.",
      { format: z.enum(["json", "markdown"]).optional().default("json") },
      async ({ format }) => {
        const tree = await listTasks(currentUser());
        return text(
          format === "markdown"
            ? toMarkdown(tree, await userNameMap())
            : { tasks: tree },
        );
      },
    );

    server.tool(
      "get_task",
      "Get one task by id — its full detail plus its notes (decisions + standup callouts), linked commits, activity log/comments, and direct subtasks. Use this before working a task, or any time you need its history/context.",
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
      "Create a new task. Only `title` is required. Status defaults to backlog. `value` and `difficulty` are Fibonacci points (1/2/3/5/8); `importance` is the -2…3 priority ladder (default 0 Normal). Pass parentId to create it as a subtask, or boardId to file it onto a specific board (see list_projects).",
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
        parentId: z.string().optional(),
        boardId: z.string().nullable().optional(),
      },
      async (input) =>
        text({ task: await createTask(input, currentUser(), AI_AUTHOR) }),
    );

    server.tool(
      "update_task",
      "Update fields on an existing task. Only the fields you pass change. Pass null to clear a nullable field (startDate, dueDate, value, difficulty, description). Pass an empty array to clear assignees/dependsOn. WORKFLOW: `status` is the process spine (backlog → todo → analyzing → analyzed → building → done); moving to analyzing or beyond locks the code. Write the revisable free-text fields here — `analysisSummary` (the Analysis: what & why) and `plan` (the Technical Plan: how) during analysis, and `summary` at the end (a short write-up of what shipped; you can diff git to help). Keep all three concise — length is the driver's call.",
      {
        id: z.string(),
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
        assignee: z
          .string()
          .max(120)
          .optional()
          .describe("a user id, email, or display name — matches one of a task's assignees"),
        text: z.string().max(200).optional().describe("substring of title or description"),
        dueBefore: ymd.optional(),
        dueAfter: ymd.optional(),
        overdue: z.boolean().optional().describe("past due and not done"),
        boardId: z.string().optional(),
        projectId: z.string().optional(),
        format: z.enum(["json", "markdown"]).optional().default("json"),
      },
      async ({ format, ...filter }) => {
        // Assignees are stored as account ids; resolve a human name/email to an
        // id so the filter matches. Unresolvable → a sentinel that matches none.
        if (filter.assignee) {
          filter.assignee =
            (await resolveAssignees([filter.assignee]))[0] ?? "__no_such_user__";
        }
        const result = await searchTasks(currentUser(), filter);
        return text(
          format === "markdown"
            ? toMarkdown(result, await userNameMap())
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
        const task = await mintRef(id, currentUser(), AI_AUTHOR);
        return task ? text({ task }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "add_note",
      "Add a note to a task — the one log for anything worth remembering. Use `decision` ONLY for a SIGNIFICANT choice, and usually only when the user says 'log this…' — never reflexively for small choices (put the 'why' in the note body). Use a standup-worthy callout otherwise: `progress`, `milestone`, `blocker`, `question`, `fyi`. Use `review` ONLY when the user explicitly asks you to flag something for them to visually double-check later — never add review notes on your own initiative. `tags` are free-form labels (e.g. \"technical\", \"product\") for later filtering.",
      {
        id: z.string(),
        note: z.string().min(1).max(10_000),
        type: noteTypeEnum.optional(),
        tags: z.array(z.string().min(1).max(60)).max(20).optional(),
      },
      async ({ id, note, type, tags }) => {
        const n = await addNote(id, { note, type, tags }, currentUser(), AI_AUTHOR);
        return n ? text({ note: n }) : text({ error: "Task not found" });
      },
    );

    server.tool(
      "list_notes",
      "Query notes ACROSS all your tasks — filter by task, type (e.g. decision), or date range. Returns only OPEN notes unless `includeResolved` is true. Use for retros ('show our technical decisions'), audits, the standup digest, and listing open `review` items to double-check.",
      {
        taskId: z.string().optional(),
        type: noteTypeEnum.optional(),
        from: z.string().max(40).optional(),
        to: z.string().max(40).optional(),
        includeResolved: z.boolean().optional(),
      },
      async (filter) => {
        const notes = await listNotes(currentUser(), filter);
        return text({ count: notes.length, notes });
      },
    );

    server.tool(
      "resolve_note",
      "Check off (resolve) or re-open a note by its id — used to clear a transient note (e.g. a `review` item) once it's been handled, so it drops out of the live Notes view and standup. The user owns their review list; only resolve when they ask.",
      {
        id: z.string(),
        resolved: z.boolean().default(true),
      },
      async ({ id, resolved }) => {
        const n = await resolveNote(id, resolved, currentUser());
        return n ? text({ note: n }) : text({ error: "Note not found" });
      },
    );

    server.tool(
      "link_commit",
      "Record a git commit against a task so the task page lists what shipped it. Pass the `sha` (and ideally the `subject` line). Idempotent per (task, sha). Commit messages should reference the task's locked code, e.g. `[GH-20] …`.",
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
      "Assemble a standup digest for a date window: notes (grouped by type — includes decisions) and tasks finished in the window with their summaries. Dates are ISO/YYYY-MM-DD (inclusive).",
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
    /* CANVAS — free-form whiteboards for brainstorming.                  */
    /* ----------------------------------------------------------------- */

    server.tool(
      "list_canvases",
      "List the canvases (free-form brainstorming whiteboards). Canvases are team-visible. Returns each canvas's id, name, and timestamps — no nodes. Use get_canvas to read a canvas's contents.",
      {},
      async () => text({ canvases: await listCanvases() }),
    );

    server.tool(
      "get_canvas",
      "Get one canvas by id with all its nodes. A node is either a `text` block (markdown in `content`) or a `section` (a titled board container whose `content` is its label). Positions/sizes are in canvas coordinates.",
      { id: z.string() },
      async ({ id }) => {
        const canvas = await getCanvas(id);
        return canvas ? text({ canvas }) : text({ error: "Canvas not found" });
      },
    );

    server.tool(
      "create_canvas",
      "Create a new (empty) canvas — a free-form whiteboard for brainstorming.",
      { name: z.string().min(1).max(120) },
      async ({ name }) =>
        text({ canvas: await createCanvas(currentUser(), name) }),
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
        return await promptMsg(
          `I want you to work on task **${code} — ${result.task.title}** (id: ${taskId}).\n\n` +
            `Here it is:\n\n${JSON.stringify(result.task, null, 2)}\n\n` +
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
        const decisionNotes = result.notes.filter((n) => n.type === "decision");
        return await promptMsg(
          `Let's finish task **${t.code ?? taskId} — ${t.title}** (id: ${taskId}).\n\n` +
            `Recorded plan:\n${t.plan ?? "_(none)_"}\n\n` +
            `Recorded decisions:\n${
              decisionNotes.length
                ? decisionNotes
                    .map((n) => `- ${n.note}${n.tags.length ? ` [${n.tags.join(", ")}]` : ""}`)
                    .join("\n")
                : "_(none)_"
            }\n\n` +
            `Run the **Finish** step of the todo workflow contract (in your server ` +
            `instructions / the \`todo://workflow\` resource): write a short ` +
            `\`summary\` of what actually shipped — you can diff git since${
              since ? ` (~${since})` : ""
            } (or the branch point) and compare against the plan + decisions above ` +
            `to help. Add the context the diff can't show — the why, key decisions, ` +
            `gotchas, follow-ups — and give any scope added along the way its own ` +
            `line. Keep it concise. Then ask me "Can I mark this as done?" and ` +
            `only complete_task once I confirm — never just because the code is ` +
            `written; I may want to view or visually check something first.`,
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
        return await promptMsg(
          `Here's the raw material for a standup covering ${from} → ${to}:\n\n` +
            `${JSON.stringify(data, null, 2)}\n\n` +
            `Please write a concise, shareable standup update: group notes into **Progress**, **Blockers**, **Questions**, and **To review** (review-type notes still open); list what shipped (finished tasks + one-line summaries); and call out any notable decisions. Keep it tight enough to paste into a team channel.`,
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
