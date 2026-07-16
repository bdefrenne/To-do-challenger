# To-do Challenger

A lightweight, **ClickUp-style task list** — grouped by status, drag-and-drop
reordering/nesting, priorities, tags, due dates, sub-tasks, a per-task detail
modal with an activity log, and a **Today** view.

What makes it different: it's **AI-native**. The task board is a real database
behind one API, and **Claude Code (or any AI) can read *and* write your tasks**
over the [Model Context Protocol](https://modelcontextprotocol.io) — a true
two-way link. You edit in the browser; Claude edits over MCP; you're both writing
to the same source of truth, and the board updates live.

Built with **Next.js 16** · React 19 · TypeScript · Tailwind v4 · **Neon Postgres**
· **Drizzle** · **MCP**.

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
humans and AI can never drift out of sync.

## Multi-user

Every task belongs to a **user**. There is no shared board: you only ever see,
edit, or expose to an AI the tasks you own.

- **Web login** — email + password. A signed, HttpOnly session cookie keeps you
  logged in; unauthenticated visits redirect to `/login`.
- **Accounts** are created by the workspace owner (there's no public signup) —
  see `npm run db:seed` and the "Add a user" script below.
- **Connect your Claude** — each user mints their own **personal API token** on
  the in-app **Connect Claude** page. That token identifies the user, so a
  user's Claude (or any MCP/REST client) is scoped to *only that user's* tasks.
  Tokens are stored hashed and shown in plaintext exactly once.

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
fallback keeps localhost working). Generate one into `.env.local` **and** your
Vercel env:

```bash
openssl rand -hex 32              # put the result in SESSION_SECRET
```

There is **no** global API token any more — access is per-user (see above).

### 3. Create tables + seed

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
SEED_EMAIL=teammate@example.com SEED_NAME="Teammate" SEED_PASSWORD=… \
  npx tsx -e 'import {loadEnvConfig} from "@next/env"; loadEnvConfig(process.cwd(),true); \
    import("./src/lib/db/users").then(m => m.createUser(process.env.SEED_EMAIL!, process.env.SEED_NAME!, process.env.SEED_PASSWORD!)).then(u => {console.log("created", u.email); process.exit(0)})'
```

(Or wipe everything and re-seed from scratch: `npm run db:reset && npm run db:migrate && npm run db:seed`.)

## Connect Claude Code (the direct link)

Open the **Connect Claude** page in the app, create a token, and copy the
ready-made command it shows you. It looks like:

```bash
claude mcp add --transport http todo \
  http://localhost:3000/api/mcp \
  --header "Authorization: Bearer <your-personal-token>"
```

(Swap the URL for `https://<your-app>.vercel.app/api/mcp` once deployed.)

Claude now has these tools: `list_tasks`, `get_task`, `create_task`,
`update_task`, `move_task`, `complete_task`, `add_comment`, `delete_task` — all
scoped to your tasks. Anything Claude changes shows up on your board within a
few seconds, and its edits are attributed to **Claude** in each task's activity
log.

### Resources — attachable context

The server also exposes your board as MCP **resources**: read-only context you
can drop straight into a Claude Code conversation (`@`-mention them) without
spending a tool call. All are scoped to your tasks.

| URI | What it is |
|---|---|
| `todo://board` | The whole board as compact Markdown — skimmable. |
| `todo://board.json` | The full nested task tree as JSON. |
| `todo://today` | In-progress + planned tasks, plus anything due today or overdue. |
| `todo://task/{id}` | One task with its full activity log (browse ids from the resource list). |

### Prompts — board-aware slash commands

And a set of **prompts** — canned commands that pre-fill Claude with your real
data plus instructions:

| Prompt | Does |
|---|---|
| `/plan_my_day` | Embeds today's tasks and asks for a prioritized plan; can reorder via `move_task`/`update_task`. |
| `/triage_backlog` | Embeds the backlog and proposes priorities + due dates via `update_task`. |
| `/weekly_review` | Summarizes what you completed this week and what's gone stale, with next steps. |
| `/breakdown_task` | Takes a `taskId`, proposes subtasks creatable via `create_task`. |

For example, in a Claude Code session:

```
/plan_my_day
```

Claude sees your live `todo://today` and comes back with an ordered plan.

## REST API (for any AI / script)

All endpoints require a credential that identifies the user: either the login
session cookie (web UI) or `Authorization: Bearer <your-personal-token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/tasks` | list all tasks (nested tree) |
| `GET` | `/api/tasks?flat=1` | flat list |
| `GET` | `/api/tasks?format=markdown` | AI-skimmable board as Markdown |
| `POST` | `/api/tasks` | create `{ title, status?, priority?, … }` |
| `GET` | `/api/tasks/:id` | one task + activity log |
| `PATCH` | `/api/tasks/:id` | update fields (partial) |
| `DELETE` | `/api/tasks/:id` | delete |
| `POST` | `/api/tasks/:id/move` | `{ parentId?, status?, position? }` |
| `POST` | `/api/tasks/:id/complete` | `{ done?: boolean }` |
| `POST` | `/api/tasks/:id/comments` | `{ message, author? }` |

```bash
curl -s https://<app>/api/tasks?format=markdown \
  -H "Authorization: Bearer $API_TOKEN"
```

## Data model

`tasks` (self-referential `parentId` for nesting, fractional `position` for
order, `statusSince` for the "N days in status" display) and `task_logs`
(activity + comments). Schema lives in
[`src/lib/db/schema.ts`](src/lib/db/schema.ts); it mirrors the app types in
[`src/lib/types.ts`](src/lib/types.ts).

## Scripts

```bash
npm run dev          # dev server
npm run build        # production build
npm run db:generate  # generate a migration from schema changes
npm run db:migrate   # apply migrations
npm run db:push      # push schema directly (dev)
npm run db:studio    # Drizzle Studio (browse the DB)
npm run db:seed      # reset + load sample data
```

## Design tokens

The whole look lives in [`src/app/globals.css`](src/app/globals.css) (`@theme`
block); components reference the tokens via Tailwind utilities, so re-theming is
a one-file change.
