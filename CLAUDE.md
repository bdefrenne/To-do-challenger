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
`list_tasks` / `search_tasks` / `get_task`, `standup`, `list_decisions` /
`list_notes`, and the write tools (`create_task`, `update_task`,
`complete_task`, `record_decision`, …). Follow the todo MCP's own usage
instructions when creating or modifying anything.

**Todo mapping.** When creating a task here (per the global "always work from
the todo" rule), file it under the **To Do Challenger** project → **To Do**
board (`TD`).

## Commands

- `npm run dev` — dev server
- `npm run db:generate` / `npm run db:migrate` — Drizzle migrations
- `npx tsc --noEmit` · `npm run lint` · `npm run build` — checks before committing

## Conventions

- A project's/board's description lives in `DESCRIPTION.md` in its repo and
  mirrors the app; keep the two in sync (see above). This is the *description*
  layer — distinct from this instructions file.
- **Visual-review notes.** When Ben asks you to flag something for a later
  visual check, add a `review`-type note to the relevant task
  (`add_note type:"review"`). Never add review notes on your own initiative —
  only when Ben explicitly asks. Ben checks them off himself (they clear via
  `resolve_note`); don't resolve them for him.
