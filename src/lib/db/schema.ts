/*
  ====================================================================
  DATABASE SCHEMA (Drizzle + Postgres/Neon)
  The single source of truth for tasks. Mirrors the shapes in
  ../types.ts so the UI keeps working, but now persisted and reachable
  by any client — the web app, the REST API, and the MCP server.
  ====================================================================
*/

import {
  pgTable,
  pgEnum,
  text,
  date,
  timestamp,
  doublePrecision,
  integer,
  smallint,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ---- Users ----
   Each person who logs into the web app. Owns their own tasks; nobody
   else can see or touch them. Passwords are salted+hashed (see
   ../session.ts) — we never store plaintext. */
export const users = pgTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    /** Display name — editable by the user; shown on avatars + as an assignee. */
    name: text("name").notNull(),
    /** `scrypt$<salt>$<hash>` — see hashPassword in ../session.ts. */
    passwordHash: text("password_hash").notNull(),
    /** Avatar ring/stroke color (hex). Chosen by the user; defaults to the accent. */
    color: text("color").notNull().default("#7b68ee"),
    /** Vercel Blob public URL of the profile picture, or null (initials fallback). */
    avatarUrl: text("avatar_url"),
    /** Working language ("en" | "fr"). Non-French users get an English directive
     *  appended to every prompt the app produces. */
    language: text("language").notNull().default("en"),
    /** ≤4-char ref prefix used as the LAST fallback for a task's code (board →
     *  project → user). Nullable in the DB (backfilled + set on demand); the
     *  service always resolves a usable prefix. */
    code: text("code"),
    /** Per-user ref counter (used when a task's code falls back to the user). */
    nextSeq: integer("next_seq").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(sql`lower(${t.email})`)],
);

/* ---- API tokens ----
   Per-user bearer tokens. This is how a user connects THEIR Claude (or
   any MCP/REST client) to THEIR tasks: the token identifies the user,
   so every AI edit is scoped to just that person's board. We store only
   a SHA-256 hash — the plaintext is shown once at creation and never again. */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the plaintext token. Never the token itself. */
    tokenHash: text("token_hash").notNull(),
    /** Human label so a user can tell their tokens apart ("Laptop"). */
    label: text("label").notNull().default("Claude"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_tokens_hash_idx").on(t.tokenHash),
    index("api_tokens_user_idx").on(t.userId),
  ],
);

/* ---- Telegram links ----
   Binds a Telegram DM (chat_id) to an app user so the bot can act AS that
   user against the same MCP server Claude Code uses. Created by a one-time
   `/start <code>` handshake seeded from the Connect page (see
   telegramLinkCodes). We mint a dedicated per-user API token at link time
   and keep its plaintext encrypted here (AES-GCM, same key as Google
   refresh tokens) so the webhook can hand it to the Anthropic MCP
   connector on every message — mcpTokenId lets us revoke it on unlink.

   thread is a short rolling transcript (last N turns) for multi-turn
   context ("add this to THAT task"); pendingConfirm holds a destructive
   op (delete / bulk) frozen until the user taps Confirm. */
export const telegramLinks = pgTable(
  "telegram_links",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Telegram chat id (numeric, stored as text). One link per DM. */
    chatId: text("chat_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** AES-GCM ciphertext of the per-user MCP bearer token (never plaintext). */
    mcpTokenEnc: text("mcp_token_enc").notNull(),
    /** apiTokens.id of that token, so unlinking can revoke it. */
    mcpTokenId: text("mcp_token_id").notNull(),
    /** Rolling last-N turns: [{ role, content }]. Trimmed on write. */
    thread: jsonb("thread").notNull().default(sql`'[]'::jsonb`),
    /** A held destructive op awaiting a Confirm tap, or null. */
    pendingConfirm: jsonb("pending_confirm"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("telegram_links_chat_idx").on(t.chatId),
    index("telegram_links_user_idx").on(t.userId),
  ],
);

/* ---- Telegram link codes ----
   Short-lived one-time codes seeded on the Connect page and consumed by the
   bot's `/start <code>`. Proves the person messaging the bot is the logged-in
   user before we bind their chat. Consumed (deleted) on use; expired rows are
   ignored (and swept lazily). */
export const telegramLinkCodes = pgTable(
  "telegram_link_codes",
  {
    /** The random code carried in the t.me deep link. */
    code: text("code").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("telegram_link_codes_user_idx").on(t.userId)],
);

/* ---- Google Calendar connections ----
   The ONE thing we persist for the calendar feature: an OAuth connection
   good enough to mint access tokens. Events themselves are never stored —
   Google is the source of truth and we read them live (read-through).

   Two kinds, both visible to (and writable by) the whole team:
     • scope="shared"   — connected once, app-wide (one row, enforced by a
                          partial unique index). Everyone sees it.
     • scope="personal" — one per user (their own Google account). Every
                          user sees EVERY personal connection, not just
                          their own — `userId` is only owner/label metadata,
                          not a read/write fence.

   The refresh token is AES-256-GCM encrypted at rest (see ../google/crypto.ts),
   in the same "never store anything usable in the clear" spirit as passwords
   and API tokens. */
export const googleScope = pgEnum("google_scope", ["shared", "personal"]);

/* A calendar's semantic TYPE — a behavior, not just a label:
     • standard  — a normal calendar; freely editable from the calendar view.
     • holidays  — read-only in the UI (can't add/delete from the view), but
                   addressable by code via the tag "holidays" (see
                   resolveTarget) so an agent can manage it programmatically. */
export const googleCalendarType = pgEnum("google_calendar_type", [
  "standard",
  "holidays",
]);

export const googleConnections = pgTable(
  "google_connections",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    scope: googleScope("scope").notNull(),
    /** Semantic type — drives view read-only rules + tag addressing. */
    type: googleCalendarType("type").notNull().default("standard"),
    /** Owner (personal) or whoever connected it (shared). NOT a read/write
     *  scope — all connections are team-visible. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The connected Google account's email. */
    googleEmail: text("google_email").notNull(),
    /** Which calendar on that account we read/write ("primary" or an id). */
    calendarId: text("calendar_id").notNull().default("primary"),
    /** AES-256-GCM ciphertext of the OAuth refresh token — never plaintext. */
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    /** Cached access token + its expiry; refreshed on demand from the refresh token. */
    accessToken: text("access_token"),
    accessTokenExpiry: timestamp("access_token_expiry", { withTimezone: true }),
    /** Display color for this calendar's event chips. */
    color: text("color").notNull().default("#7b68ee"),
    /** Human label ("Shared" or the owner's name). */
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // At most ONE shared connection app-wide.
    uniqueIndex("google_conn_shared_idx")
      .on(t.scope)
      .where(sql`${t.scope} = 'shared'`),
    // At most one personal connection per user.
    uniqueIndex("google_conn_personal_user_idx")
      .on(t.userId)
      .where(sql`${t.scope} = 'personal'`),
    // At most ONE holidays calendar app-wide (so the "holidays" tag is
    // unambiguous). Standard calendars are unconstrained.
    uniqueIndex("google_conn_holidays_idx")
      .on(t.type)
      .where(sql`${t.type} = 'holidays'`),
    index("google_conn_user_idx").on(t.userId),
  ],
);

/* ---- Projects ----
   Top level of the hierarchy — e.g. one whole game. Owned by a user;
   holds a set of Boards. */
export const projects = pgTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** ≤4-char ref prefix for tasks scoped to this project but not a board
     *  (board → PROJECT → user fallback). Nullable; set on create + backfilled. */
    code: text("code"),
    /** Accent color (hex) for the project — mirrors users.color. */
    color: text("color").notNull().default("#7b68ee"),
    /** Project picture — a public blob URL (mirrors users.avatarUrl). Nullable. */
    image: text("image"),
    /** Path to this project's git working directory, so AIs know where its
     *  code lives on disk. Repo-relative or absolute. Nullable. */
    gitFolder: text("git_folder"),
    /** Markdown "readme" explaining what this project is and its constraints,
     *  so AIs without code access understand it. Nullable. */
    description: text("description"),
    /** Per-project ref counter (used when a task's code falls back to project). */
    nextSeq: integer("next_seq").notNull().default(1),
    /** Fractional sort key for ordering projects in the sidebar. */
    position: doublePrecision("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("projects_user_idx").on(t.userId)],
);

/* ---- Boards ----
   Sub level: one Trello-style board within a project. Every task lives
   in exactly one board. `userId` is denormalized from the project so
   per-user queries and ownership checks stay simple (mirrors tasks). */
export const boards = pgTable(
  "boards",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** ≤4-char ref prefix (e.g. "GH" for Guitar Hero) — the primary source of
     *  a task's code. Nullable; derived from the name on create + backfilled. */
    code: text("code"),
    /** Accent color (hex) for the board — mirrors users.color. */
    color: text("color").notNull().default("#7b68ee"),
    /** Board picture — a public blob URL (mirrors users.avatarUrl). Nullable. */
    image: text("image"),
    /** Path to this board's git working directory, so AIs know where its
     *  code lives on disk. Repo-relative or absolute. Nullable. */
    gitFolder: text("git_folder"),
    /** Markdown "readme" explaining what this board is and its constraints,
     *  so AIs without code access understand it. Nullable. */
    description: text("description"),
    /** Per-board ref counter; incremented atomically to mint task numbers. */
    nextSeq: integer("next_seq").notNull().default(1),
    /** Fractional sort key for ordering boards within a project. */
    position: doublePrecision("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("boards_user_idx").on(t.userId),
    index("boards_project_idx").on(t.projectId),
  ],
);

/* ---- Project members ----
   Which roster users belong to a project. Purely a CURATION layer for the
   assignee picker — a member does NOT gain read/write access to the owner's
   project (data stays owner-private; see the userId fences in service.ts).
   When a task on a project/board is assigned, the picker offers only these
   people (falling back to the whole roster when a project has no members set).
   Boards/tasks inherit their project's members — membership is project-level.
   The owner is always kept as a member (new tasks auto-assign to them). */
export const projectMembers = pgTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_members_user_idx").on(t.userId),
  ],
);

/* ---- Enums (mirror the string unions in types.ts) ---- */
export const taskStatus = pgEnum("task_status", [
  "backlog",
  "todo",
  "analyzing",
  "analyzed",
  "building",
  "review",
  "done",
]);

/** How often a task repeats (null-ish default is "none"). */
export const recurrence = pgEnum("recurrence", [
  "none",
  "daily",
  "weekly",
  "monthly",
]);

export const logKind = pgEnum("log_kind", [
  "created",
  "status",
  "moved",
  "nested",
  "started",
  "paused",
  "done",
  "reopened",
  "comment", // human- or AI-authored note
  "attached", // an image/file was attached or removed
  "updated", // one or more fields changed via a bulk update
]);

/* ---- Tasks ----
   Flat table with self-referential parentId for nesting (matches the
   TaskNode tree in the UI). `position` is a fractional sort key so we
   can insert between two rows without renumbering everything. */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Creator. TEAM-VISIBLE like canvases: every signed-in user can see and
     *  edit every task, so `userId` is only "who created it" metadata + the
     *  ref-code namespace (a task Simon creates reads `SIM-…`) — never a
     *  read/write fence. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: taskStatus("status").notNull().default("backlog"),
    /** Assigned people, as `users.id`s (resolved from name/email/id at the
     *  write boundary). Empty array = unassigned. NB: the physical column is
     *  still named `assignees` (it once held display-name strings; a data
     *  migration backfilled the ids in place) — the property is the source of
     *  truth for its meaning. */
    assigneeIds: text("assignees")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** When work should start; pairs with dueDate (the end). */
    startDate: date("start_date"),
    dueDate: date("due_date"),
    description: text("description"),
    /** How often it repeats. */
    recurrence: recurrence("recurrence").notNull().default("none"),
    /** Task ids this task is blocked by (must finish first). */
    dependsOn: text("depends_on")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Open-ended user-defined fields — the ClickUp custom-field bag. */
    customFields: jsonb("custom_fields")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Fibonacci payoff points (1/2/3/5/8) — the "value" axis. */
    value: smallint("value"),
    /** Fibonacci effort points (1/2/3/5/8) — the "difficulty" axis. */
    difficulty: smallint("difficulty"),
    /** Importance ladder: 2 High · 1 Elevated · 0 Normal (default) · -1 Low.
     *  Most tasks stay Normal. */
    importance: smallint("importance").notNull().default(0),
    /** Which board this task lives on (null = unassigned / no board yet). */
    boardId: text("board_id").references(() => boards.id, {
      onDelete: "cascade",
    }),
    /** Which project this task is scoped to when it has no board (board →
     *  PROJECT → user fallback for the code). Set to the board's project
     *  whenever boardId is set; SET NULL if the project is deleted. */
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    /* ---- Ref / code ----
       Every task shows a human code like `GH-20`. `seq` is the number, drawn
       from the current owner's counter (board → project → user) at creation
       and re-drawn if the owner changes while unlocked. While unlocked the
       prefix is derived live from the owner (so a soft code follows moves);
       on lock, the whole string is frozen into `ref`. */
    seq: integer("seq"),
    /** The FROZEN code string (e.g. "GH-20"), set only once, on lock. */
    ref: text("ref"),
    /** True once the code is locked (handoff / first mutation). Immutable after. */
    refLocked: boolean("ref_locked").notNull().default(false),
    /** When the code was locked. */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /* ---- Revisable free-text fields (rewritten in place; decisions/notes are
       logs). Labels in the UI: Analysis / Technical Plan / Summary. The process
       stage lives in `status` — no separate analyzedAt timestamp. ---- */
    analysisSummary: text("analysis_summary"),
    plan: text("plan"),
    summary: text("summary"),
    /** Nesting: null = top-level. */
    parentId: text("parent_id"),
    /** Fractional index for ordering within a status group. */
    position: doublePrecision("position").notNull().default(0),
    /** When it entered its current status (drives "Nd in <status>"). */
    statusSince: timestamp("status_since", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the task entered "done"; cleared when reopened. Doubles as the
     *  workflow "finishedAt". */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Set when a done task is archived (hidden from active views); cleared on
     *  un-archive or when the task leaves "done". Only done tasks can be set. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tasks_user_idx").on(t.userId),
    index("tasks_board_idx").on(t.boardId),
    index("tasks_project_idx").on(t.projectId),
    index("tasks_parent_idx").on(t.parentId),
    index("tasks_status_idx").on(t.status),
    index("tasks_archived_idx").on(t.archivedAt),
  ],
);

/* ---- Activity log + comments ----
   One row per event. `kind = "comment"` rows are notes (human or AI);
   everything else is auto-generated activity. */
export const taskLogs = pgTable(
  "task_logs",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: logKind("kind").notNull(),
    message: text("message").notNull(),
    /** Who did it — e.g. "You", "Claude", an assignee name. */
    author: text("author"),
  },
  (t) => [index("task_logs_task_idx").on(t.taskId)],
);

/* ---- Image attachments ----
   Images pasted or uploaded onto a task. Bytes live in Vercel Blob; we
   store only the metadata + public URL here. Cascade-deletes with the
   task (the blob objects themselves are cleaned up in deleteTask). */
export const taskAttachments = pgTable(
  "task_attachments",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    /** Vercel Blob public URL — used directly as an <img src>. */
    url: text("url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("task_attachments_task_idx").on(t.taskId)],
);

/* ---- Decisions ----
   First-class, cross-task, queryable record of choices made while working a
   task. Categorized + phase-stamped as they happen; the `outcome` fields are
   filled LATER in a retro pass ("were these good?"). Its own table (not the
   activity log) precisely because you retrieve + filter these across all tasks
   on a Decisions page. */
/* ---- Notes ----
   One log for everything worth remembering on a task — from a human or the AI.
   `type` says what kind: a `decision` (a choice made, optionally with a "Why"),
   or a standup-worthy callout (`progress` / `milestone` / `blocker` /
   `question` / `fyi`), or a `review` (something to visually double-check
   later). `tags` are free-form labels (e.g. a decision's old category like
   "technical"). Deliberately NOT graded — no retro/outcome. Transient notes can
   be checked off via `resolvedAt`. */
export const noteType = pgEnum("note_type", [
  "decision",
  "progress",
  "milestone",
  "blocker",
  "question",
  "fyi",
  "review",
]);

export const taskNotes = pgTable(
  "task_notes",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: noteType("type"),
    note: text("note").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    author: text("author"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // When set, the note has been "checked off" — resolved and dropped from the
    // live Notes view + standup. Transient notes (review/blocker/question) use
    // this; permanent ones (decision/milestone) just leave it null.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("task_notes_task_idx").on(t.taskId),
    index("task_notes_user_idx").on(t.userId),
  ],
);

/* ---- Commits ----
   Git commits linked back to a task (recorded by the AI via link_commit) so a
   task page can list the commits that shipped it. Closes the loop the commit
   convention `[GH-20] …` opens. */
export const taskCommits = pgTable(
  "task_commits",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    subject: text("subject"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("task_commits_task_idx").on(t.taskId),
    uniqueIndex("task_commits_task_sha_idx").on(t.taskId, t.sha),
  ],
);

/* ---- Canvas / whiteboard ----
   A free-form brainstorming space (Miro/Figma-style). A `canvas` is a
   standalone document; `canvasNodes` are the things on it — text blocks and
   sections (board containers) — positioned in canvas coordinates.
   `viewport`/`data` are jsonb so the shape can grow (last pan/zoom, per-node
   font size, a section's bound board) without a migration. Everything is
   user-scoped like the rest of the app.
   NOTE: `frame` is a legacy enum value — the frame feature was removed and
   nothing writes it; it's left in the enum to avoid a Postgres enum migration. */
export const canvasNodeKind = pgEnum("canvas_node_kind", [
  "text",
  "frame",
  "section",
  "draw",
  "image",
]);

export const canvases = pgTable(
  "canvases",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Last-saved pan/zoom, so reopening restores the view: { x, y, scale }. */
    viewport: jsonb("viewport").notNull().default(sql`'{}'::jsonb`),
    /** Fractional sort key for ordering canvases in the index. */
    position: doublePrecision("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("canvases_user_idx").on(t.userId)],
);

export const canvasNodes = pgTable(
  "canvas_nodes",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    /** "text" = a markdown text block; "section" = a Figma-style titled outline
     *  bound to a board (`data.boardId`), whose lines are that board's live
     *  tasks; "draw" = a freehand pen stroke; "image" = a pasted/dropped picture
     *  whose blob URL lives in `data.url`. ("frame" is a removed legacy kind —
     *  see the enum note above.) */
    kind: canvasNodeKind("kind").notNull(),
    /** Markdown for a text node; the label/title for a section. */
    content: text("content").notNull().default(""),
    /** Position + size in canvas coordinates (unaffected by pan/zoom). */
    x: doublePrecision("x").notNull().default(0),
    y: doublePrecision("y").notNull().default(0),
    width: doublePrecision("width").notNull().default(200),
    height: doublePrecision("height").notNull().default(80),
    /** Optional accent (hex) — e.g. a sticky's tint. */
    color: text("color"),
    /** Fractional z-order (higher = on top). */
    position: doublePrecision("position").notNull().default(0),
    /** Free-form extras: font size, and a section's bound `boardId`. */
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("canvas_nodes_user_idx").on(t.userId),
    index("canvas_nodes_canvas_idx").on(t.canvasId),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type BoardRow = typeof boards.$inferSelect;
export type NewBoardRow = typeof boards.$inferInsert;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type NewProjectMemberRow = typeof projectMembers.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TaskLogRow = typeof taskLogs.$inferSelect;
export type NewTaskLogRow = typeof taskLogs.$inferInsert;
export type TaskAttachmentRow = typeof taskAttachments.$inferSelect;
export type NewTaskAttachmentRow = typeof taskAttachments.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type NewApiTokenRow = typeof apiTokens.$inferInsert;
export type TelegramLinkRow = typeof telegramLinks.$inferSelect;
export type NewTelegramLinkRow = typeof telegramLinks.$inferInsert;
export type TelegramLinkCodeRow = typeof telegramLinkCodes.$inferSelect;
export type NewTelegramLinkCodeRow = typeof telegramLinkCodes.$inferInsert;
export type GoogleConnectionRow = typeof googleConnections.$inferSelect;
export type NewGoogleConnectionRow = typeof googleConnections.$inferInsert;
export type TaskNoteRow = typeof taskNotes.$inferSelect;
export type NewTaskNoteRow = typeof taskNotes.$inferInsert;
export type TaskCommitRow = typeof taskCommits.$inferSelect;
export type NewTaskCommitRow = typeof taskCommits.$inferInsert;
export type CanvasRow = typeof canvases.$inferSelect;
export type NewCanvasRow = typeof canvases.$inferInsert;
export type CanvasNodeRow = typeof canvasNodes.$inferSelect;
export type NewCanvasNodeRow = typeof canvasNodes.$inferInsert;
