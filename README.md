# To-do Challenger

A **ClickUp-style task manager** — projects & boards, a grouped list view, kanban
boards, sub-tasks with drag-and-drop nesting, tags, assignees, start/due dates,
value/difficulty (Fibonacci) points, recurrence, dependencies, image attachments,
a per-task detail modal with an activity log, and a **Today** view.

What makes it different: it's **AI-native**. The board is a real database behind
one service layer, and **Claude Code (or any AI) can read *and* write your tasks**
over the [Model Context Protocol](https://modelcontextprotocol.io) — a true
two-way link. You edit in the browser; Claude edits over MCP; you're both writing
to the same source of truth, and the board updates live (~2s). It also connects to
**Google Calendar** so tasks and meetings live side by side.

Built with **Next.js 16** · React 19 · TypeScript · Tailwind v4 · **Neon Postgres**
· **Drizzle** · **Vercel Blob** · **MCP** · **Google Calendar**.

## Architecture — one source of truth, many clients

```
        Postgres (Neon)         ← the real source of truth
              │
        Service layer           src/lib/db/service.ts  (all task logic)
              │
   ┌──────────┼───────────┐
 Web UI    REST API     MCP server
 (you)   /api/tasks     /api/mcp   ← Claude Code / any AI
```

The web UI is just another API client — the exact same door the AI uses — so
humans and AI can never drift out of sync. Everything (list, kanban, REST, MCP)
goes through [`src/lib/db/service.ts`](src/lib/db/service.ts).

## Multi-user

Every task belongs to a **user**. There is no shared board: you only ever see,
edit, or expose to an AI the tasks you own.

- **Web login** — email + password. A signed, HttpOnly session cookie keeps you
  logged in; unauthenticated visits redirect to `/login`.
- **Accounts** are created by the workspace owner (no public signup) — see
  `npm run db:seed` and `npm run user:create` below.
- **Connect your Claude** — each user mints their own **personal API token** on
  the in-app **Connect Claude** page. That token identifies the user, so a user's
  Claude (or any MCP/REST client) is scoped to *only that user's* tasks. Tokens
  are stored hashed and shown in plaintext exactly once.

## Setup

### 1. Database (Neon Postgres)

Create a Neon Postgres DB from your Vercel project → **Storage** (empty the
custom-prefix so the var is named `DATABASE_URL`; enable the *Development*
environment). Then pull it locally:

```bash
vercel env pull .env.local        # gets DATABASE_URL
```

Or copy `.env.example` → `.env.local` and paste a connection string.

### 2. Session secret

Login cookies are signed with `SESSION_SECRET` (required in production; a dev
fallback keeps localhost working):

```bash
openssl rand -hex 32              # put the result in SESSION_SECRET
```

There is **no** global API token — access is per-user (see above).

### 3. Google Calendar (optional)

To use the Calendar view + calendar MCP tools, add a Google OAuth client and a
token-encryption key (full instructions in [`.env.example`](.env.example)):

```
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   # OAuth client (Web application)
GOOGLE_TOKEN_ENC_KEY                       # openssl rand -hex 32 — encrypts refresh tokens at rest
```

Redirect URI: `${origin}/api/google/callback`. Then connect a calendar in
**Settings → Calendars**. Skip this section and everything except calendar works.

### 4. Create tables + seed

```bash
npm install
npm run db:migrate                # create the tables
npm run db:seed                   # create the owner account + sample tasks
npm run dev                       # http://localhost:3000
```

`db:seed` prints the owner's email + password. Override the defaults with
`SEED_EMAIL`, `SEED_NAME`, `SEED_PASSWORD` (see `.env.example`). Sign in at
`/login`.

### Add another user

```bash
npm run user:create -- teammate@example.com "Teammate" a-strong-password
```

(Or wipe everything and start over: `npm run db:reset && npm run db:migrate && npm run db:seed`.)

## Connect Claude Code (the direct link)

Open the **Connect Claude** page in the app, create a token, and copy the
ready-made command it shows you:

```bash
claude mcp add --transport http todo \
  http://localhost:3000/api/mcp \
  --header "Authorization: Bearer <your-personal-token>"
```

(Swap the URL for `https://<your-app>.vercel.app/api/mcp` once deployed.)

Everything Claude changes shows up on your board within ~2s, attributed to
**Claude** in each task's activity log. Tools (all scoped to your tasks):

| Group | Tools |
|---|---|
| **Tasks** | `list_tasks`, `get_task`, `create_task`, `update_task`, `move_task`, `complete_task`, `add_comment`, `delete_task` |
| **Search** | `search_tasks` — filter by status, assignee, tag, text, due window, or overdue (prefer over `list_tasks` for targeted questions) |
| **Organize** | `list_projects`, `create_project`, `create_board`, `rename_board`, `rename_project` — plus `boardId` on `create_task`/`move_task` to file work onto a board |
| **Bulk** | `bulk_update` (same patch to many), `bulk_apply` (ordered mixed create/update/move/complete/comment/delete) |
| **Attachments** | `get_attachment` (view an image inline) |
| **Calendar** | `list_calendars`, `list_calendar_events`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event` |

### Resources — attachable context

Read-only board context you can `@`-mention into a Claude Code conversation
without spending a tool call. All scoped to your tasks.

| URI | What it is |
|---|---|
| `todo://board` | The whole board as compact Markdown — skimmable. |
| `todo://board.json` | The full nested task tree as JSON. |
| `todo://today` | In-progress + planned tasks, plus anything due today or overdue. |
| `todo://task/{id}` | One task with its full activity log (browse ids from the resource list). |

### Prompts — board-aware slash commands

Canned commands that pre-fill Claude with your real data plus instructions:

| Prompt | Does |
|---|---|
| `/plan_my_day` | Embeds today's tasks and asks for a prioritized plan; can reorder via `move_task`/`update_task`. |
| `/triage_backlog` | Embeds the backlog and proposes value/difficulty + due dates via `update_task`. |
| `/weekly_review` | Summarizes what you completed this week and what's gone stale, with next steps. |
| `/breakdown_task` | Takes a `taskId`, proposes subtasks creatable via `create_task`. |

## REST API (for any AI / script)

Every endpoint requires a credential that identifies the user: the login session
cookie (web UI) or `Authorization: Bearer <your-personal-token>`.

### Tasks

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/tasks` | list tasks (nested tree); supports filters below |
| `GET` | `/api/tasks?flat=1` | flat list |
| `GET` | `/api/tasks?format=markdown` | AI-skimmable board as Markdown |
| `POST` | `/api/tasks` | create `{ title, status?, assignees?, dueDate?, value?, difficulty?, tags?, parentId?, boardId?, … }` |
| `GET` | `/api/tasks/:id` | one task + activity log + attachments |
| `PATCH` | `/api/tasks/:id` | update fields (partial); optional `expectedUpdatedAt` optimistic lock |
| `DELETE` | `/api/tasks/:id` | delete (subtasks re-parented to top) |
| `POST` | `/api/tasks/:id/move` | `{ parentId?, status?, position?, boardId? }` |
| `POST` | `/api/tasks/:id/complete` | `{ done?: boolean }` |
| `POST` | `/api/tasks/:id/comments` | `{ message, author? }` |
| `POST` | `/api/tasks/:id/attachments` | multipart `file` (image, ≤4 MB) → Vercel Blob |
| `DELETE` | `/api/tasks/:id/attachments/:attachmentId` | remove an attachment |
| `POST` | `/api/tasks/bulk` | `{ ids, patch }` **or** `{ operations: [...] }` |

**Filters** on `GET /api/tasks` (combine freely, AND-ed together):
`boardId`, `projectId`, `status` (csv, e.g. `in-progress,planned`), `assignee`,
`tag`, `text` (or `q`), `dueBefore`, `dueAfter`, `overdue`.

```bash
curl -s "https://<app>/api/tasks?status=in-progress,planned&overdue=1&text=doc" \
  -H "Authorization: Bearer $TOKEN"
```

### Projects, boards, tokens, sync

| Method | Path | Purpose |
|---|---|---|
| `GET` `POST` | `/api/projects` | list / create projects |
| `PATCH` `DELETE` | `/api/projects/:id` | rename / delete a project |
| `POST` | `/api/boards` | create a board `{ projectId, name }` |
| `PATCH` `DELETE` | `/api/boards/:id` | rename / delete a board |
| `POST` | `/api/boards/reorder` | `{ projectId, orderedIds }` |
| `GET` `POST` | `/api/tokens` | list / mint personal API tokens |
| `DELETE` | `/api/tokens/:id` | revoke a token |
| `GET` | `/api/version` | change-cursor for cheap polling |
| `POST` | `/api/auth/login` · `/api/auth/logout` | session cookie |

### Google Calendar

OAuth: `GET /api/google/connect` → `GET /api/google/callback`. Connections and
events are managed under `/api/calendar/connections/*` and `/api/calendar/events/*`
(and the calendar MCP tools). See [`src/app/api/calendar/`](src/app/api/calendar/)
and [`src/lib/google/`](src/lib/google/).

## Data model

Schema lives in [`src/lib/db/schema.ts`](src/lib/db/schema.ts) and mirrors the app
types in [`src/lib/types.ts`](src/lib/types.ts):

- **users**, **api_tokens** (per-user bearer tokens, stored hashed)
- **projects** → **boards** (fractional `position` order)
- **tasks** — `boardId`, self-referential `parentId` (nesting), `position`,
  `status`/`statusSince`/`completedAt`, `assignees[]`, `startDate`/`dueDate`,
  `recurrence`, `dependsOn[]`, `value`/`difficulty` (Fibonacci), `tags[]`,
  `customFields` (JSONB)
- **task_logs** (activity + comments), **task_attachments** (image metadata; bytes in Vercel Blob)
- Google Calendar connections (encrypted refresh tokens; see `src/lib/google/`)

## Scripts

```bash
npm run dev          # dev server
npm run build        # production build
npm run db:generate  # generate a migration from schema changes
npm run db:migrate   # apply migrations
npm run db:push      # push schema directly (dev)
npm run db:studio    # Drizzle Studio (browse the DB)
npm run db:seed      # create the owner account + sample tasks
npm run db:reset     # drop everything (pair with db:migrate + db:seed)
npm run db:backfill  # backfill boards for pre-existing tasks
npm run user:create  # create a user (SEED_EMAIL/NAME/PASSWORD)
```

## Design tokens

The whole look lives in [`src/app/globals.css`](src/app/globals.css) (`@theme`
block); components reference the tokens via Tailwind utilities, so re-theming is
a one-file change.
