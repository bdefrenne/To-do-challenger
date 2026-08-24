# Implementation Plan — Task Workflow

> **Notes are discontinued (TD2-209).** Everything below about notes —
> `add_note` / `list_notes` / `resolve_note`, decisions, standup callouts,
> `review` items, the Notes page, canvas sticky notes and the `task_notes`
> table — describes a feature that no longer exists. It is kept as history.
> A decision or trade-off now lives in the task's own `analysisSummary` /
> `plan` / `summary`, a passing remark in a comment, and anything to check
> later is its own task.

Turns [task-workflow.md](./task-workflow.md) into shippable work. Sequenced in
**5 layers**, each independently deployable and useful on its own, so nothing is
a big-bang. Every layer follows the repo's existing spine:

> **The service layer ([src/lib/db/service.ts](../src/lib/db/service.ts)) is the
> one code path.** REST ([src/app/api/…](../src/app/api)), MCP
> ([src/app/api/mcp/route.ts](../src/app/api/mcp/route.ts)), and the web UI all
> call the same functions. Zod schemas are shared via
> [src/lib/api.ts](../src/lib/api.ts). Migrations: edit
> [schema.ts](../src/lib/db/schema.ts) → `npm run db:generate` → `npm run
> db:migrate`. Data backfills go in `scripts/` (see `backfill-boards.ts`).

Because the AI drives the lifecycle from either entry path, **the protocol is
carried by MCP tool/prompt descriptions** — treat the description strings as
product surface, not comments.

---

## Layer 1 — Codes & refs (`GH-20`)

The foundation everything else references. No workflow behavior yet — just
stable, human-friendly ids.

**Schema** ([schema.ts](../src/lib/db/schema.ts))
- `boards`, `projects`, `users`: add `code text NOT NULL` (≤4 chars) and
  `nextSeq integer NOT NULL DEFAULT 1` (the per-owner counter).
- `tasks`: add
  - `projectId text` (nullable, FK → projects) — enables the board→**project**→user
    fallback for boardless tasks; set it to the board's project whenever `boardId` is set.
  - `seq integer` (nullable) — the number drawn from the current owner's counter.
  - `ref text` (nullable) — the **frozen** string, set only on lock.
  - `refLocked boolean NOT NULL DEFAULT false`, `lockedAt timestamptz`.
- Uniqueness: a partial/composite unique index so every `code` a user owns
  (across boards + projects + their user row) is distinct.

**Code generation** (new `src/lib/refs.ts`)
- `deriveCode(name)` → ≤4-char uppercase from initials/first letters
  ("Guitar Hero" → `GH`, "Tower Defense" → `TD`).
- `ensureUniqueCode(userId, candidate)` → append `2`, `3`… on collision.

**Service** ([service.ts](../src/lib/db/service.ts))
- `allocSeq(owner)` — atomic `UPDATE <owner> SET next_seq = next_seq + 1
  RETURNING next_seq` (no interactive txns on Neon HTTP — one statement is the
  guarantee).
- `createTask`: resolve current owner (board→project→user), `allocSeq`, store `seq`.
- `moveTask`: if the **owner prefix changes while unlocked**, re-`allocSeq` from
  the new owner (leaving a harmless gap in the old). If locked, `ref` is untouched.
- `mintRef(taskId)` — idempotent lock: `UPDATE … SET ref = <prefix-seq>,
  refLocked = true, lockedAt = now() WHERE id = ? AND ref_locked = false`. If
  already locked, return existing. This is the single lock funnel.
- Displayed code helper: locked → `ref`; unlocked → `<currentPrefix>-<seq>*`
  (prefix derived live from the owner, so a soft code follows board moves and
  board-code renames with no write fan-out).
- Surface `ref` / `refLocked` / displayed code in `TaskDTO`, `rowToTask`,
  `toMarkdown`.

**Types** ([types.ts](../src/lib/db/../types.ts)): add `code`, `ref`,
`refLocked` to `Task`; `code` to `Board`/`Project`.

**MCP / REST**: include the code in every task payload; return board/project
`code` from `list_projects`; allow editing a board/project `code`
(`updateBoard`/`updateProject` + schemas in api.ts).

**UI**: render the code (with trailing `*` when unlocked) on List rows, the
detail modal, and search results; add code edit to board/project settings.

**Migration / backfill** (`scripts/backfill-refs.ts`)
- Give every existing board/project a derived unique `code`; give each user a code.
- Assign existing tasks a `seq` per board in `createdAt` order and **lock them**
  (they're real work already), setting each board's `nextSeq` past the max.

**Done when:** every task shows a code; new tasks show `GH-20*`; moving an
unlocked task between boards changes its code; existing tasks are locked.

---

## Layer 2 — Lifecycle timestamps + summaries

**Schema** (`tasks`): add nullable `analysisStartedAt`, `analyzedAt`,
`workStartedAt` timestamptz (reuse existing `completedAt`); add text columns
`analysisSummary`, `plan`, `summary`.

**Service**
- `derivePhase(task)` → `draft | ready | analyzing | analyzed | working | done`
  (pure function of the timestamps + `refLocked`; see the table in the spec).
- Extend `updateTask` to accept the new timestamp + summary fields; expose
  `phase` on `TaskDTO`.
- Auto-fire hooks are wired in Layers 3–5 (first decision → `analysisStartedAt`,
  first plan/commit → `workStartedAt`). For now, expose the setters.

**MCP / REST**: extend `update_task` (and `updateTaskSchema` in api.ts) with the
new fields; include `phase` + summaries in `get_task`.

**UI**: show the phase badge and the three summaries in the detail modal.

**Done when:** a task carries the four timestamps + three summaries and reports
a derived phase, end to end.

---

## Layer 3 — Decisions (own table + page)

**Schema** (new `taskDecisions`): `id`, `taskId` (FK, cascade), `userId`
(denormalized, like tasks/boards, for cheap per-user scoping), `category`
enum(`business`,`product`,`ux`,`technical`,`scope`), `decision text`,
`rationale text`, `phase` enum(`analysis`,`execution`), `author`,
`createdAt`; retro fields nullable: `outcome`, `reviewedAt`, `reviewNote`;
optional `supersededById`.

**Service**: `recordDecision(taskId, input)` — inserts, and **auto-fires**
`analysisStartedAt`/`workStartedAt` on the parent task based on current phase.
`listDecisions(userId, filter)` — cross-task, filter by category/board/project/
date/`outcomeSet`. `reviewDecision(id, outcome, note)`.

**MCP**: `record_decision` tool (description teaches "log each decision as it's
made, not at the end"); `list_decisions` query tool; `review_decisions` prompt
(pulls filtered decisions, asks the AI to grade them against outcomes + code).

**REST + UI**: `/api/decisions` (+ filter query); a **Decisions page** — a
cross-task, filterable table.

**Done when:** the AI logs categorized decisions that appear in the timeline and
on the Decisions page, and logging one flips the task into the analyzing phase.

---

## Layer 4 — Notes + standup (own table + page)

**Schema** (new `taskNotes`): `id`, `taskId` (FK), `userId`, `type`
enum(`progress`,`blocker`,`question`,`fyi`) nullable, `note text`, `author`,
`createdAt`. Sibling of decisions — deliberately no `outcome` (notes aren't graded).

**Service**: `addNote(taskId, input)`; `listNotes(userId, {from,to,type,…})`.

**MCP**: `add_note` tool; `standup` prompt — sweeps a date range across all
tasks and assembles: notes grouped by type + tasks finished in the window with
their `summary` + notable decisions → one shareable digest (sibling of the
existing `weekly_review`).

**REST + UI**: `/api/notes`; a **Notes page**; a standup/digest view.

**Done when:** notes are captured and the standup prompt produces a grouped,
shareable update.

---

## Layer 5 — Handoff prompts + commit linking (wires the whole flow)

**MCP prompts** ([mcp/route.ts](../src/app/api/mcp/route.ts))
- `work_on_task(taskId)` — **calls `mintRef` (locks the code)**, then emits the
  pre-filled prompt embedding the frozen ref + the protocol (gather context →
  log decisions → set timestamps → reconcile at finish).
- `finish_task(taskId)` — the **reconciliation**: instructs the AI to diff git
  since `workStartedAt`/branch point, compare against `plan` + logged decisions,
  enumerate what actually shipped, write `summary`, then set `completedAt`
  (status → done). (Git runs in the AI's own environment, not server-side.)

**Commit linking** (new `taskCommits`: `taskId`, `sha`, `subject`, `createdAt`,
or a `commit` log kind)
- `link_commit(taskId, sha, subject)` tool — records the SHA on the task and
  **auto-fires `workStartedAt`**; task page lists its commits.

**Protocol wiring**: fold the lifecycle rules into `record_decision` /
`add_note` / `update_task` / `link_commit` tool descriptions so **Path B**
(Claude Code direct, no board UI) follows the same steps.

**UI**: the **Copy prompt** button on a task — calls a mint+prompt endpoint,
returns the ready-to-paste text with the now-locked code.

**Done when:** both entry paths lock the code, drive the lifecycle
automatically, and produce a reconciled `summary` with linked commits.

---

## Cross-cutting notes

- **Atomicity without transactions.** The Neon HTTP driver has no interactive
  transactions (see `bulkApply`'s comment). All allocation/lock steps are
  single conditional statements (`UPDATE … RETURNING`, `WHERE ref_locked =
  false`) so they're safe under concurrency.
- **Immutability.** Once `refLocked`, `ref` is never rewritten — not on board
  move, not on board-code rename. Enforce in `moveTask`/`updateBoard`.
- **Gaps are expected.** Deletes and unlocked board-moves skip numbers; that's
  the accepted Jira-style cost of "every task always shows a code."
- **Author attribution** already exists (`"You"` vs `"Claude"` = `AI_AUTHOR`);
  decisions/notes reuse it.
- **Ordering:** Layers 1–2 are prerequisites; 3 and 4 are independent of each
  other; 5 depends on 1–4. Ship 1 → 2 → (3 ‖ 4) → 5.
