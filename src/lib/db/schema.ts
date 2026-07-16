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
    name: text("name").notNull(),
    /** `scrypt$<salt>$<hash>` — see hashPassword in ../session.ts. */
    passwordHash: text("password_hash").notNull(),
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
    /** Nesting: null = top-level. */
    parentId: text("parent_id"),
    /** Fractional index for ordering within a status group. */
    position: doublePrecision("position").notNull().default(0),
    /** When it entered its current status (drives "Nd in <status>"). */
    statusSince: timestamp("status_since", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the task entered "done"; cleared when reopened. */
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
export type GoogleConnectionRow = typeof googleConnections.$inferSelect;
export type NewGoogleConnectionRow = typeof googleConnections.$inferInsert;
