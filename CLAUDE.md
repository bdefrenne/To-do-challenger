# CLAUDE.md

Working notes for AI agents in this repo.

## What this is

For **what this project is and its constraints**, see
[DESCRIPTION.md](./DESCRIPTION.md). It mirrors this project's description in
To-do Challenger — **if you edit one, update the other.**

## Stack

Next.js (App Router, TypeScript, Tailwind) · Postgres (Neon) + Drizzle ORM ·
deployed on Vercel · Vercel Blob for images.

## Architecture

One **service layer** (`src/lib/db/service.ts`), three surfaces: the web UI,
the REST API (`src/app/api/*`), and the MCP server (`src/app/api/mcp`). When you
add or change a field, thread it through **schema → types → service → API
schemas (`src/lib/api.ts`) → routes → MCP → UI** so all three surfaces agree.

## Live data (todo MCP)

This session has the **`todo` MCP server** connected — a live link to a running
To-do Challenger instance (the same app this repo builds). So the user may ask
questions about *actual* tasks, projects, and boards, not just the code, e.g.
"what's on my plate today?", "what did I decide on task X?", "add a task for …".

Answer those against the MCP, not the source. Useful tools: `list_projects`,
`list_tasks` / `search_tasks` / `get_task`, `standup`, `board_review`, and the
write tools (`create_task`, `update_task`, `complete_task`, `add_comment`, …).
Follow the todo MCP's own usage instructions when creating or modifying
anything.

**Todo mapping.** When creating a task here (per the global "always work from
the todo" rule), file it under the **RYDR** project → **TO DO** board (`TD2`).
(It used to be the *To Do Challenger* project → *To Do* board `TD`; older tasks
still carry `TD-*` refs. Ben moved it 2026-08-18 so this work sits with the rest
of the RYDR board set.)

## Commands

- `npm run dev` — dev server
- `npm run db:generate` / `npm run db:migrate` — Drizzle migrations
- `npx tsc --noEmit` · `npm run lint` · `npm run build` — checks before committing
- `npm run check:outline` — the outline/text-view logic checks (222 pure assertions:
  the row⇄field merge, per-row locks, fractional positions, delete subtrees, what
  each structural key does to the row list, and the create/move op payloads those
  rows produce).
  **Run it after touching anything in `src/lib/outline.ts`,
  `useOutlineDraft.ts`, `OutlineEditor.tsx` or `useRowLock.ts`** — that code is
  co-editing, task creation and deletion at once, so a wrong answer there loses a
  task, duplicates one, or yanks the caret out of someone's hands rather than
  merely rendering oddly. Six real bugs came out of writing these, three of them
  from cases nobody had hit yet.
- `npm run check:review` — the board-cleanup flag rules (51 pure assertions: the
  two staleness ladders in working days, what each status owes, when a
  `silentEdit` is real, and the severity order). **Run it after touching
  `reviewFlags` / `boardReview` / the thresholds in `src/lib/db/service.ts`** —
  the flags decide which tasks an agent looks at first and, because `capped()`
  drops from the tail, which ones a truncated read silently loses; a wrong weight
  hides the task that most needed attention rather than rendering oddly.
- `npm run check:activity` — the activity-feed checks (19 assertions, against
  DATABASE_URL: that a call actually reaches Postgres, that a 20k-char argument
  is clipped before it does, that a FAILING call is still recorded, and that the
  merged feed interleaves both streams newest-first). **Run it after touching
  `mcp-log.ts`, `activityFeed` / `mcpCallStats`, or `instrument()` in the MCP
  route** — `recordMcpCall` is fire-and-forget by design, so nothing upstream
  ever sees it fail and this script is the only place the write is proven to
  land.
- `npm run check:devlogin` — the dev sign-in fence (17 pure assertions: the
  `NODE_ENV` × `DEV_LOGIN` × `VERCEL` truth table, open in exactly one row, and
  that the cookie it mints is the same signed cookie `/api/auth/login` produces
  — tampered ones rejected). **Run it after touching `src/lib/dev-login.ts` or
  `src/app/api/dev/login/route.ts`** — that route hands a session for any
  account with no credential at all, so the gate is the entire security model
  and a loosened condition is not something to discover in production.
- `npm run check:bulk` — the write-path checks, against DATABASE_URL (it makes its
  own scratch tasks and cleans up). This is where a rule the pure suite can only
  *state* gets proven to reach the database: canvas pins across a board change,
  `bulkApply`'s results contract, and the create `position` the outline computes
  for a line opened mid-list. **Run it after touching `createTask` / `moveTask` /
  `bulkApply` or the request schemas in `src/lib/api.ts`** — a field that a zod
  schema silently strips fails nowhere else.
- `npm run check:delete` — what blocks a board/project delete and what the delete
  destroys (19 assertions, against DATABASE_URL; makes its own scratch
  project/boards/tasks and purges them). **Run it after touching
  `cascadeTaskCount` / `hiddenTaskCount` / `deleteBoard` / `deleteProject`** —
  `tasks.board_id` is ON DELETE CASCADE, so that count is the entire safety
  model on the one exit in the app that ends a task without the Trash: count a
  hidden row and a board nobody can empty is stuck forever; miss a live one and
  someone's work is gone with no undo.

## Conventions

- A project's/board's description lives in `DESCRIPTION.md` in its repo and
  mirrors the app; keep the two in sync (see above). This is the *description*
  layer — distinct from this instructions file.
- **A board/project delete is blocked by LIVE tasks only (TD2-214).**
  `cascadeTaskCount` counts what's on the board; archived and trashed rows are
  not counted, because refusing on them named tasks the person could not see
  anywhere (a board that reads empty and still won't delete). They ARE destroyed
  by the cascade, with no Trash stop — so any surface with a human in front of it
  reads `hiddenTaskCount` and says how many first (`useHiddenTaskCount` +
  `/api/tasks/hidden-count` do that for the two modals). Proven by
  `npm run check:delete`.
- **Deleting is soft (TD2-196).** `tasks.deletedAt` means "in the Trash". Two
  fences keep it off every surface, and a new read path must go through one of
  them rather than filtering for itself: `taskWhere` (every list/search/digest
  read) and `resolveTaskId` (every write, which is why a trashed task simply
  can't be edited). A query that builds its own WHERE on `tasks` — a recursive
  subtree CTE, a join from `task_status_events` — has to add
  `deleted_at IS NULL` itself; `purgeTask` / `emptyTrash` are the only calls that
  drop rows, and they refuse anything not already in the Trash. Scripts that make
  scratch tasks must PURGE them (see `scrub` in the check scripts) or the bin
  fills up with test residue.
- **Hiding a board happens in `listProjects`, nowhere else (TD2-213).**
  `boards.hidden` means "put away": the board keeps its tasks, refs and history
  and simply stops being drawn. `listProjects` is the ONE place that reads the
  column — it splits the rows into `Project.boards` (what a project shows) and
  `Project.hiddenBoards` — so all three surfaces and every view hide a board for
  free, and a view written later inherits that instead of needing a filter it has
  never heard of. **Never add a per-view `hidden` filter**, and never read the
  column outside that function. The one exception is a NAME lookup — a task on a
  hidden board is still in the Trash, the Archived view and the task table, and
  its own page must still load — which unions the two arrays through
  `allBoards` / `findBoard` in `src/lib/boards.ts`. The test for which you want:
  "which boards does this project SHOW?" is `project.boards`; "what is the board
  with this id CALLED?" is `allBoards`. On the canvas there is no new code at
  all — the lane reconciler reads the visible set, so a hidden board is
  indistinguishable from one that left the project and its lanes are swept from
  every tray.
- **Every MCP call is logged at ONE chokepoint (TD2-211).** `instrument()` in
  the MCP route patches `server.tool` / `server.prompt` before any registration
  runs, so a tool added later is recorded because it is a tool — **never add
  per-tool logging**, and never register a tool outside that callback. The rows
  land in `mcp_calls` and surface on **/activity**, merged with `task_logs`.
  The two tables answer different questions and both are needed: `task_logs` is
  what CHANGED (every surface), `mcp_calls` is what was ASKED (agents only,
  including the reads that change nothing and appear nowhere else).
- **Looking at a page (TD2-212).** In local development only, `/login` grows a
  profile picker: click a user, you're in, no password. For an agent it's one
  URL — `/api/dev/login?as=<email>&next=/activity` signs in and lands on the
  page, which is what makes a headless screenshot possible in a single browser
  invocation. **Verify a UI change by looking at it, not just by `npm run
  build`.** The gate is `devLoginEnabled()` in `src/lib/dev-login.ts` and lives
  ONLY there — three conditions (`NODE_ENV !== "production"`, `DEV_LOGIN=1`, no
  `VERCEL`), all server-side, answering 404 when shut. Never mirror it into a
  `NEXT_PUBLIC_` flag: a second copy of a fence can disagree with the first, and
  it fails open. Two things to hold in mind while driving the app: **dev shares
  Postgres with production**, so every click is a write to the real board (the
  picker says `LIVE DATA` and names the host for this reason) — browse as
  `testuser` rather than as a real person, so a stray edit isn't attributed to
  them.
- **Notes are DISCONTINUED (TD2-209).** The whole feature is gone: no
  `add_note` / `list_notes` / `resolve_note`, no decisions, standup callouts or
  `review` items, no Notes page, no canvas sticky notes, no `task_notes` table.
  If an older instruction — here, in the global `CLAUDE.md`, or in a habit —
  tells you to add or resolve a note, **that instruction is stale: say so and
  don't try**, nothing will accept the call. A decision or trade-off goes in the
  task's `analysisSummary` / `plan`, what shipped and its gotchas in its
  `summary`, a passing remark in a comment (`add_comment`), and anything Ben
  wants to check later is its own task. If he asks you to "note" or "flag"
  something, ask which of those he means.
