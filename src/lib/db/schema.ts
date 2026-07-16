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

/* ---- Enums (mirror the string unions in types.ts) ---- */
export const taskStatus = pgEnum("task_status", [
  "backlog",
  "planned",
  "in-progress",
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
    /** Owner. A task is only ever visible to (and editable by) this user. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: taskStatus("status").notNull().default("backlog"),
    /** People assigned (display names). Empty array = unassigned. */
    assignees: text("assignees")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** When work should start; pairs with dueDate (the end). */
    startDate: date("start_date"),
    dueDate: date("due_date"),
    description: text("description"),
    /** Tag ids (see the TAGS catalog in mock-data.ts). */
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
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
    /* ---- Lifecycle timestamps (informational, non-gating) ----
       Phase is DERIVED from these; kanban `status` stays orthogonal. */
    analysisStartedAt: timestamp("analysis_started_at", { withTimezone: true }),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    workStartedAt: timestamp("work_started_at", { withTimezone: true }),
    /* ---- Revisable summaries (rewritten in place; decisions/notes are logs) ---- */
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
export const decisionCategory = pgEnum("decision_category", [
  "business",
  "product",
  "ux",
  "technical",
  "scope",
]);

/** Which lifecycle phase the decision was made in (auto-stamped from the task). */
export const decisionPhase = pgEnum("decision_phase", ["analysis", "execution"]);

/** Retro verdict — nullable until reviewed. */
export const decisionOutcome = pgEnum("decision_outcome", [
  "good",
  "mixed",
  "bad",
]);

export const taskDecisions = pgTable(
  "task_decisions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** Denormalized owner (like tasks/boards) for cheap per-user scoping. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: decisionCategory("category").notNull(),
    /** The decision itself, one line. */
    decision: text("decision").notNull(),
    /** Why — the reasoning behind it. */
    rationale: text("rationale"),
    phase: decisionPhase("phase").notNull().default("analysis"),
    author: text("author"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /* ---- Retro (filled later) ---- */
    outcome: decisionOutcome("outcome"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    /** A later decision that reversed/replaced this one (retro signal). */
    supersededById: text("superseded_by_id"),
  },
  (t) => [
    index("task_decisions_task_idx").on(t.taskId),
    index("task_decisions_user_idx").on(t.userId),
  ],
);

/* ---- Notes ----
   Team-facing callouts (from human or AI) meant to be surfaced at standup:
   "blocked on design", "endpoint shipped, needs QA". Sibling of decisions —
   its own table + Notes page — but deliberately NOT graded (no outcome). */
export const noteType = pgEnum("note_type", [
  "progress",
  "blocker",
  "question",
  "fyi",
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
    author: text("author"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type BoardRow = typeof boards.$inferSelect;
export type NewBoardRow = typeof boards.$inferInsert;
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
export type TaskDecisionRow = typeof taskDecisions.$inferSelect;
export type NewTaskDecisionRow = typeof taskDecisions.$inferInsert;
export type TaskNoteRow = typeof taskNotes.$inferSelect;
export type NewTaskNoteRow = typeof taskNotes.$inferInsert;
export type TaskCommitRow = typeof taskCommits.$inferSelect;
export type NewTaskCommitRow = typeof taskCommits.$inferInsert;
