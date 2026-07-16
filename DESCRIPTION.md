> **Keep this in sync.** This file mirrors the description of its project/board
> in To-do Challenger. If you edit this file, you MUST update the description
> there too (via the app or the `todo` MCP) — and if you edit it there, you MUST
> update this file. Reference this file from CLAUDE.md so coding agents find it.

# To-do Challenger

A light, ClickUp-style task manager built so a person **and their AI** (Claude
Code, over MCP) work the *same* board through the *same* service layer — an AI
edit and a human edit go through the exact same door.

## What it is

- **Next.js** (App Router, TypeScript, Tailwind) on **Vercel**, backed by
  **Postgres (Neon)** via **Drizzle ORM**.
- **Three surfaces, one service layer** (`src/lib/db/service.ts`): the web UI,
  a REST API (`src/app/api/*`), and an **MCP server** (`src/app/api/mcp`).
- **Hierarchy:** Project → Board → Task. Tasks carry Jira-style refs
  (`PREFIX-seq`) whose prefix resolves board → project → user.
- **Per-user isolation:** the web app authenticates with a signed session
  cookie; MCP/REST use per-user **bearer tokens**, so a user's Claude only ever
  sees and edits that user's data.
- **Projects & boards** each have: name, shortname (`code`), color, picture,
  `gitFolder`, and a Markdown description mirrored to this file.
- **Integrations:** Vercel Blob (pictures), Google Calendar, a Telegram bot.

## Constraints

- The deployed app **cannot read or write local filesystems**, so `gitFolder`
  is only a pointer and repo files like this one are synced **by convention**,
  not automatically (see the banner above).
- Every write flows through the shared **service layer** — when adding a field,
  thread it through schema → types → service → API schemas → routes → MCP → UI
  so all three surfaces stay in agreement.
- Descriptions here **mirror** the board/project description in the app.
