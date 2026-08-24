# Task Workflow — from braindump to shipped

How a task moves through its whole life: created by a human, handed to an AI,
analyzed, worked, and finished with a summary that captures **everything** that
actually shipped — including scope that was added along the way without its own
task.

This is the original design spec (the "why"). It describes a richer model than
what shipped — notably a separate *derived phase* alongside `status`, extra
lifecycle timestamps (`analysisStartedAt`/`workStartedAt`), and a standalone
graded decisions table. **What actually shipped is simpler and is the source of
truth: see [task-flow.md](./task-flow.md).** In short: `status` *is* the process
spine (`Backlog → To Do → Analyzing → Analyzed → Building → Review → Done`) — there is no
separate phase — decisions are just `add_note type:"decision"`, and the code
locks when a task enters Analyzing.

---

## The primitives (quick reference)

- **Code / ref** — every task shows one, e.g. `GH-20`. Prefix resolves
  **board → project → user** (each carries an editable ≤4-char code, unique
  across everything one user owns). Number is drawn from that owner's counter
  at creation.
- **Soft vs locked** — an unlocked code is *soft*: it follows the task if the
  task changes board, and shows a trailing `*` (`GH-20*`). Locking freezes the
  exact string forever. Reordering never renumbers; only a board change (while
  soft) redraws the number. Gaps (from deletes / board moves of soft tasks) are
  fine, Jira-style.
- **Lifecycle timestamps** — `analysisStartedAt`, `analyzedAt`,
  `workStartedAt`, and the existing `completedAt`. All nullable, purely
  informational (nothing is gated on them). The **phase** is *derived* from
  which are set; kanban `status` stays orthogonal.
- **Summaries (revisable columns)** — `analysisSummary`, `plan`, `summary`.
- **Decisions (append-only table)** — categorized (business / product / ux /
  technical / scope), phase-stamped, queryable across all tasks, with a
  later-filled `outcome` for retros. Surfaced on a **Decisions page**.
- **Notes (append-only table)** — team-facing callouts (from human or AI) meant
  to be surfaced at standup: *"blocked on design," "endpoint shipped, needs
  QA."* Same shape as decisions — tied to a task, queryable across all tasks —
  and surfaced on a **Notes page** + a standup digest. Optional `type`
  (progress / blocker / question / fyi) so the digest can group them.

---

## The flow, walked through `GH-20`

### 1. Create — a soft draft

Someone adds **"Add reset password"** to the Guitar Hero board (description,
screenshot, whatever). It immediately shows a code: **`GH-20*`**. The `*` means
soft — nobody has committed to it, and if it's dragged to another board the
code follows.

At this stage you can dump many tasks, reorder them, move them between boards,
delete some — codes float, and skipped numbers are expected and harmless.

### 2. Handoff — the code locks

Work can start from either end, and **the AI drives the lifecycle either way** —
the human never flips switches:

- **Path A — from the board.** Someone clicks **Copy prompt**. The clipboard
  gets a pre-filled prompt (with the ref) and the code locks. They paste it into
  any AI (Claude Code, claude.ai, …).

  > *"I want you to work on task **GH-20 — Add reset password**. Get all the
  > info about it first (`get_task`), look at the relevant code, ask me
  > anything unclear, and then we'll work on it together."*

- **Path B — from Claude Code directly.** The human just says *"work on GH-20"*
  or *"work on the reset-password task."* The AI resolves it
  (`search_tasks` / `get_task`) — no board UI involved.

Either way, the code **locks** the moment the task is engaged: `GH-20*` →
**`GH-20`**, frozen forever (immutable even if the task later moves board or the
board code is renamed). Locking is atomic and idempotent, and funnels through
one service call whether it's triggered by the UI button, the `work_on_task`
prompt, or — as a backstop — the first real mutation. A "real" task can never
exist without a locked code, and in practice you only ever paste a code that's
already frozen.

The handoff also **assigns the human** who took it (merged, so anyone already on
the task stays). The same is true of the status spine: entering **Analyzing** or
**Building** from any agent surface — Claude over MCP, a bearer-token script, the
Telegram bot — records the acting user, whichever tool did it (`update_task`,
`move_task`, `bulk_update`, `bulk_apply`, or a task created straight into a work
status). The rule lives at the service-layer chokepoint and reads the surface off
the ambient request context, so no path can opt out by forgetting to ask. The web
UI is the deliberate exception — dragging a card across a column isn't claiming
it — and every implicit assignment says so on the activity timeline.

> **The protocol lives in the MCP layer, not the UI.** Because Path B has no
> board in the loop, every lifecycle rule below (lock, set timestamps, log
> decisions, reconcile at finish) is taught by the MCP **tool and prompt
> descriptions** and enforced in the **service layer** — so any AI, reached by
> either path, follows the same steps without being told each time.

### 3. Analysis — understand the task (business + technical)

The AI pulls the task (`get_task`), reads the codebase, and asks questions.
The lifecycle timestamps **auto-fire** from the AI's actions — nobody sets them
by hand, so the timeline reflects what actually happened:

- `analysisStartedAt` is set automatically on the **first `record_decision`**
  (the first sign real analysis is underway).
- As decisions get made, the AI logs each one immediately via `record_decision`
  — *not* saved up for the end. Examples for `GH-20`:
  - `business`: "Reset links expire after 1h" — rationale…
  - `ux`: "Send to email only, no SMS in v1" — rationale…
  - `technical`: "Reuse existing session token hashing, don't add a new lib"
- When analysis is done: `analyzedAt` is set and `analysisSummary` is written
  (a short paragraph of what was decided and why) — written for a reader who
  won't open the code, so no-code where it can be: plain words for what's
  reused, new, duplicated/relocated, out of scope, and any risk. File-level,
  step-by-step detail belongs in the `plan`, not here.

The task may **stop here** — analyzed but not started. That's a valid resting
state (the phase is just "analyzed").

### 4. Work — plan, then execute

If they decide to build it:

- `workStartedAt` is set automatically the first time the AI writes the `plan`
  or records a commit against the task (`link_commit`) — whichever comes first.
- The AI writes a short `plan` (the dev plan / order of attack).
- Execution happens. More decisions get logged as they come up — including the
  important case: **scope added on the fly** that never got its own task is
  logged as a `scope` decision (e.g. "also fixed the login rate-limit while in
  here").
- Every **commit references the ref**: `[GH-20] add reset-password endpoint`.
- Whenever something **standup-worthy** happens — a blocker, a milestone, a
  question for the team — the AI (or human) drops a `note` on the task. These
  are the raw material for the standup digest.

### 5. Finish — reconcile, don't recollect

The human says **"finish this ticket"** (or the AI runs the `finish_task`
prompt). Finishing is a **reconciliation against the repo, not a memory dump**:

1. Diff git since `workStartedAt` (or the branch point).
2. Compare that diff against the `plan` and the logged decisions.
3. Enumerate what **actually shipped** — this is what catches the untracked
   scope creep, because it comes from the diff, not from what anyone remembers.
4. Write `summary` from that enumeration.
5. Set `completedAt` (status → done).
6. Optionally record the commit SHAs back onto the task (`link_commit`) so the
   task page lists its commits.

Because decisions were logged as they happened (step 3–4), finishing is
*assembly*, not archaeology.

### 6. Standup — share what's happening

Independent of any single task, the **standup digest** (a `standup` MCP prompt +
UI view) sweeps a date range across *all* tasks and assembles: the `note`s
(grouped by type — blockers, progress, questions), the tasks finished in the
window with their `summary`, and any notable decisions. One shareable update for
the team, in the same family as the existing `weekly_review`.

### 7. Retro — were the decisions any good?

Later, independent of any single task, `review_decisions` pulls decisions
across all tasks — filterable by category (business / ux / technical / scope),
board, project, date, or "outcome not yet set" — and grades them against how
things actually turned out, filling in each decision's `outcome` / `note`.

Both live as dedicated pages: a **Decisions page** and a **Notes page**, each a
cross-task, filterable table.

### 8. Cleanup — reconcile the whole board, not one task

Steps 5–7 all reconcile *something they already know about*: one task, one day,
one decision. Nothing asks the opposite question — **has the board drifted from
the code?** A task sitting in Building for six days with no plan and no linked
commits is invisible to the finish step (nobody asked to finish it), to the
standup (it didn't move), and to the retro (no decision was logged).

`board_review` is that question, and it is deliberately **attribution-blind**: a
task rotting for five days is a fact regardless of whose it is. It gathers what's
on-going (statuses Analyzing→Review, plus THIS WEEK, plus INBOX, plus done-but-
unswept), what moved in the window, how long each has sat, whether the working
fields exist, what commits are linked, which notes are still open — and a set of
deterministic hygiene **flags** over all of it.

The split matters more here than anywhere: **the tool supplies evidence, the
agent supplies judgement.** Every flag is a *question* — `buildingNoCommits`
might be stalled work, work on a branch, or work needing no commit at all — so
the agent opens the repo to answer it, proposes, and the human decides. If the
tool ever emitted a recommendation, agents would apply it without reading the
code, and the pass would invert into an automated way to *falsify* the board.

Same shape as the day close-out, for the same reason: batch the asking, never the
deciding. Anything that completes a task goes through `complete_task` with its
own summary and its own confirmation; filing moves can go as one batch once the
human has said yes. The operative contract is `BOARD_CLEANUP` in
`src/lib/workflow.ts` (delivered as the MCP instructions, the `todo://cleanup`
resource, and the `clean_up_todo` prompt), and the flag rules are pinned by
`npm run check:review`.

Two honest limits are stated in the payload rather than hidden. `task_logs` says
*that* a field changed, never what it changed from, and title/description edits
aren't logged at all — so a task whose `updatedAt` moved with nothing to show for
it is reported as a `silentEdit` rather than as untouched. And a task has no repo
field: where its code lives comes from its board's (else its project's)
`gitFolder`, which may simply be unset, in which case the pass is confined to
board hygiene and must say so.

---

---

## Process spine (as shipped — supersedes the "derived phase" idea above)

There is **one axis**: `status`. It *is* the process — no separate derived
phase.

    Backlog → To Do → Analyzing → Analyzed → Building → Review → Done

Nothing in that spine notices a task that simply *stops*, which is what the
cleanup pass (step 8) exists to catch.

The code locks (`GH-20*` → `GH-20`) the moment a task enters **Analyzing** (the
first handoff), by any path — the picker, an AI `update_task`, or a Copy-prompt.
Done is reached via `complete_task` (keeps `completedAt` honest); the picker
itself stops at Building.

---

## What each actor touches

- **Human**: creates the task, clicks Copy prompt (locks it), decides when to
  start work and when to finish, says "finish this ticket", and — on a cleanup —
  decides what actually happens to each task the pass turned up.
- **AI**: gathers context, logs decisions as they happen, sets the lifecycle
  timestamps, writes `analysisSummary` / `plan` / `summary`, references the ref
  in commits, and on a cleanup reads the code to answer each flag before
  proposing anything.
- **System**: mints + locks codes (atomic, idempotent), derives the phase,
  keeps the activity log, runs the retro query, and computes the cleanup's
  staleness/hygiene flags — deterministically, so every surface agrees and the
  ordering of a truncated read is never arbitrary.
