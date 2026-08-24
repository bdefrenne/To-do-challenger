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
- `npm run check:bulk` — the write-path checks, against DATABASE_URL (it makes its
  own scratch tasks and cleans up). This is where a rule the pure suite can only
  *state* gets proven to reach the database: canvas pins across a board change,
  `bulkApply`'s results contract, and the create `position` the outline computes
  for a line opened mid-list. **Run it after touching `createTask` / `moveTask` /
  `bulkApply` or the request schemas in `src/lib/api.ts`** — a field that a zod
  schema silently strips fails nowhere else.

## Conventions

- A project's/board's description lives in `DESCRIPTION.md` in its repo and
  mirrors the app; keep the two in sync (see above). This is the *description*
  layer — distinct from this instructions file.
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
