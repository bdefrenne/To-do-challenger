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

## Commands

- `npm run dev` — dev server
- `npm run db:generate` / `npm run db:migrate` — Drizzle migrations
- `npx tsc --noEmit` · `npm run lint` · `npm run build` — checks before committing

## Conventions

- A project's/board's description lives in `DESCRIPTION.md` in its repo and
  mirrors the app; keep the two in sync (see above). This is the *description*
  layer — distinct from this instructions file.
