# Task Flow — creation → completion (with AIs)

The **main happy path** of a task in To-do Challenger, from capture to an AI
finishing it — as plain `[Actor]` bullets showing who does what.

The process is a single spine (the task's `status`):

**Backlog → To Do → Analyzing → Analyzed → Building → Done**

There are **two handoff points** — analysis and building can be done by
different people/AIs, or by the same one end to end:
1. **To Do → Analyzing** — hand it off to be understood + planned.
2. **Analyzed → Building** — hand the plan off to be built.

---

## THE MAIN FLOW

**Backlog** — capture
- `[User]` captures a task — a line in a Canvas *section*, the list/board view,
  or the Telegram bot. It lands in **Backlog**.
- `[System]` mints a *soft* code, `GH-20*` (the `*` = not committed yet).

**To Do** — triage
- `[User]` triages it into **To Do**: "yes, this is queued." Optionally sets
  **Importance** (`I` on a canvas card: −2 Icebox … 3 Critical); most tasks just
  stay **Normal**.

**Analyzing** — handoff #1: understand + plan
- `[User]` hands it off to an AI, one of:
  - clicks **⧉ Copy analyzing prompt** and pastes into any AI, or
  - asks Claude Code to *"analyze GH-20"* (or *"work on GH-20"*).
- `[System]` **locks** the code: `GH-20*` → `GH-20`, frozen forever, so every
  commit can cite it. Status → **Analyzing**. (The lock is guaranteed — the
  prompt does it, and a plain ask from Claude Code locks on first touch.)
- `[AI]` loads full context — `get_task` (description, notes, commits, activity,
  subtasks), reads the board/project description + `gitFolder`, reads the code —
  and asks anything unclear **before** deciding.
- `[AI]` produces two things (as long as they need to be — no length limit):
  - **Analysis** — the *what & why*: the understanding, the approach, the
    trade-offs. This is the **human-readable** layer, written for a reader who
    won't open the code (whoever picks it up may not be technical) — no-code
    where it can be, but still saying in plain words what's reused, what's new,
    what's a duplicate or relocated, what's out of scope, and any risk.
  - **Technical Plan** — the *how*: the order of attack for building it. This is
    where the file-level, step-by-step detail lives.
- `[AI]` logs only the *significant* decisions — and usually because you said
  *"log this…"*, never reflexively (`add_note type:"decision"`, the *why* in
  the body).

**Analyzed** — understood + planned, ready to build (a valid resting state)
- Status → **Analyzed** once the Analysis + Technical Plan are settled.
- The task can **rest here indefinitely** — analysis is done, nobody has
  committed to building it yet. This is also handoff point #2: the plan is ready
  for *anyone* (a different person/AI) to pick up.

**Building** — handoff #2: execute the plan
- `[User]` hands it off to build — **⧉ Copy build prompt**, or *"build GH-20"* —
  and it moves to **Building**. (Or one AI runs analyze → build straight
  through.)
- `[AI]` executes the Technical Plan.
- `[AI]` drops standup-worthy notes as they happen — `add_note`
  `progress` / `milestone` / `blocker` / `question` / `fyi`.
- `[AI]` references the code in commit messages (`[GH-20] add reset endpoint`).
  Optionally `link_commit`s a sha so the commit shows on the task page (the
  deployed app can't read your repo, so this is the only way it surfaces there).
- `[System]` polls `/api/version` (~2s) so the AI's edits appear **live** on the
  user's Canvas / board / list.

**Done** — finish
- `[User]` says *"finish this ticket"*.
- `[AI]` writes the **Summary** — **anchored in the git diff** (ground truth,
  catches what actually shipped, including scope added along the way) and
  **enriched from memory** (the *why*, key decisions, gotchas, follow-ups).
  Added scope gets its own line.
- `[AI]` `complete_task` → Status **Done** (`completedAt` set).

**Standup** — out of band, cross-task
- `[User]` runs the standup digest for a date window.
- `[System]` sweeps all tasks: notes grouped by type + tasks finished in the
  window with their summaries → one shareable update.

---

## The three written fields

| Field | The question it answers | Written during |
| ----- | ----------------------- | -------------- |
| **Analysis** | *What & why* — understanding, approach, trade-offs (human-readable, no-code where it can be) | Analyzing |
| **Technical Plan** | *How* — the order of attack (where the code detail lives) | Analyzing |
| **Summary** | *What actually shipped* | Done |

---

## Notes

- **One axis.** `status` *is* the process — there's no separate "phase". Analysis
  is real work, so it has its own stages (Analyzing / Analyzed) rather than being
  lumped under a single "in progress".
- **Two handoffs.** Analysis and building are separable — you can analyze a task
  and hand the plan to someone else (or a fresh AI session) to build.
- **Done is managed.** Reaching Done goes through `complete_task` / the Finish
  step (keeps `completedAt` honest) — the status picker itself stops at Building.
- **The code locks at the first handoff** (To Do → Analyzing), and never
  changes after.
