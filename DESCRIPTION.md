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
- **One canvas per project.** A canvas is that project's whiteboard, laying its
  boards out as sections inside machine-managed trays — INBOX · THIS WEEK ·
  BACKLOG · LATER. Every tray holds a lane for **every** board, in sidebar
  order, so the trays read as one grid: same columns, same order, every
  band — the project Boards view, laid out in space. The 1:1 is enforced, and
  it's what lets the server answer "which canvas does this task's placement go
  on?" with a lookup instead of a guess. Two things stay yours: a section you
  make inside a tray is an ordinary section and is *preferred* over a
  machine-made lane, so your own named lanes are what work lands in; and a group
  you drag stays where you put it.
- **Per-user isolation:** the web app authenticates with a signed session
  cookie; MCP/REST use per-user **bearer tokens**, so a user's Claude only ever
  sees and edits that user's data.
- **Projects & boards** each have: name, shortname (`code`), color, picture,
  `gitFolder`, and a Markdown description mirrored to this file.
- **Process model:** a task's journey (`Backlog → … → Done`), a **working day**'s
  record, and a **board cleanup** are the three contracts, written once in
  `src/lib/workflow.ts` and read by every surface — so the steps a person sees
  and the steps an agent follows can't drift. A working day runs 04:00 → 04:00
  local (`src/lib/workday.ts`), and closing one out produces the standup.
- **The board is checked against the code, not trusted.** `board_review` gathers
  everything in flight — what moved, what has sat still, what's missing a plan or
  a summary, what commits are linked, which notes are open — and flags it
  deterministically. It returns **evidence, never conclusions**: every flag is a
  question the agent answers by reading the repo, before proposing anything to a
  human who decides. Nothing else notices a task that simply stopped.
- **Keyboard-first cards:** hovering any task card — on the canvas, the project
  Boards view, a board's kanban or the task list — gives the same keys, from one
  definition (`useTaskCardShortcuts`): **D** done, **S/I/A** pickers, **1/2**
  importance, **SPACE** assign yourself, **DELETE** the delete flow (finished
  work always takes a second, deliberate press before it leaves: off the canvas
  it parks in DONE THIS WEEK first, on the canvas — which has no such tray — it
  sits in its board's lane until DELETE archives it), and the **arrows** file it:
  **↑** to the top of THIS WEEK (do it next), **→** to the bottom of THIS WEEK,
  **↓** to BACKLOG, **←** to LATER. **?** shows the cheatsheet.
- **Nothing is deleted by accident.** DELETE is a **soft delete**: the task keeps
  its id, ref, activity and subtasks, leaves every board, list, canvas and search,
  and lands in the **Trash** — newest deleted first — where **Restore** puts the
  whole branch back where it was. Only the Trash's **Empty trash** button (or a
  per-row *Delete forever*) actually destroys anything, and it refuses a task that
  hasn't been deleted first, so the irreversible step is always the second one.
  Archiving is the separate, tidier exit for *finished* work.
- **Live co-editing in a section's text view.** A canvas section flips between
  cards and an **outline** — one editable document over its task list. Several
  people can be in it at once and edit **different rows simultaneously**: a row is
  one task field, so each keystroke is an independent patch that peers apply
  without a database read (~RTT, no polling), and structure (create / nest /
  reorder / delete) is saved as real operations against fractional sort keys
  instead of a whole-list diff — which is what makes concurrent edits commute
  instead of overwriting each other. You see who is on which line and **their
  caret**, as a vertical bar at their exact character. Two people in the *same*
  field is the one case that can't merge, so that row is **held by one editor at
  a time** — the claim is just their caret, so it dies with their tab, and a
  cursor someone parked and walked away from stops blocking after a few seconds.
  You can always take a line over (**⌘⏎**, or simply type in a parked one); the
  row stays read-only for the moment that takes, so you inherit its current text
  rather than typing over a snapshot, and it tells you if the line moved while
  you waited.
- **Integrations:** Vercel Blob (pictures), Google Calendar, a Telegram bot.

## Constraints

- The deployed app **cannot read or write local filesystems**, so `gitFolder`
  is only a pointer and repo files like this one are synced **by convention**,
  not automatically (see the banner above).
- Every write flows through the shared **service layer** — when adding a field,
  thread it through schema → types → service → API schemas → routes → MCP → UI
  so all three surfaces stay in agreement.
- Descriptions here **mirror** the board/project description in the app.
