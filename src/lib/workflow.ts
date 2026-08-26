/*
  The one canonical todo-MCP workflow contract.

  This is the SINGLE source of truth for how an AI should behave when working a
  task through the todo MCP. Every other surface derives from or points at it:
    - the MCP server `instructions` (delivered to every client on connect),
    - the `todo://workflow` resource (re-readable on demand),
    - the `work_on_task` / `finish_task` prompts, and
    - the "Copy prompt" clipboard string.
  Change the process here and every surface updates — no drift, no re-explaining.

  It's the runtime distillation of the design spec in docs/task-workflow.md
  (that doc stays the "why"; this constant is the operative "how").
*/

export const WORKFLOW = `# Working with the todo system

Follow this whenever you start, modify, or finish work through the todo MCP.
Keep it lightweight — don't log for the sake of logging.

**Status is the process spine** (set it with \`update_task\`):

    Backlog → To Do → Analyzing → Analyzed → Building → Review → Done

Moving a task to **Analyzing or beyond locks its code** (\`GH-20*\` → \`GH-20\`) —
a stable, permanent ref for the task. There are two handoffs: To Do → Analyzing
(understand + analysis) and Analyzed → Building (tech plan + execute) — they can be done by
different people/AIs, or by you end to end.

Moving a task into **Analyzing or Building auto-assigns it to you** (the user
you're working with), so the board records who's on it — no need to assign
yourself by hand. Existing assignees are kept. This holds for **every** tool
that sets the status — \`update_task\`, \`create_task\`, \`move_task\`,
\`bulk_update\`, \`bulk_apply\` — so you can't start work without the board
recording who it's for. Taking a handoff assigns you too (\`work_on_task\`,
\`lock_task\`, or the human clicking Copy prompt), even when the status hasn't
moved yet.

**Where a task lands on the canvas.** \`placement\` picks the group, and it's an
axis of its own — it never changes a task's status, and status never changes it
beyond the one rule below.

| \`placement\` | means |
| --- | --- |
| \`inbox\` | untriaged — the default, and where anything unfiled shows up |
| \`thisWeek\` | to be done this week, or you're starting on it now |
| \`backlog\` | triaged, but not scheduled |
| \`later\` | deliberately deferred — what to pass when the user says "later" |
| \`doneThisWeek\` | finished this week, waiting to be swept |

Pass it to \`create_task\` / \`update_task\`. Setting the status to Analyzing or
beyond already files a task nobody has placed by hand onto THIS WEEK, so the
normal "create it, then start work" flow needs nothing extra. Every project's
canvas has a THIS WEEK group and the rest of the trays automatically, so filing
always has somewhere to land.

**To start**, call \`get_task\` to load the full context (description, commits,
activity, subtasks) and read the relevant code. Ask about anything unclear before deciding. (The
\`work_on_task\` prompt does this and locks the code for you.)

**Look at the images.** If the task came back with a non-empty
\`attachments\` array, someone attached those screenshots *because the words
weren't enough* — a mockup, a bug they couldn't describe, an error on screen.
Call \`get_attachment\` on **every** id, before you analyze or plan. They are
part of the brief, not decoration, and you cannot see them from the metadata
alone.

**Read the code, don't infer it from other tasks.** A task's
\`analysisSummary\`/\`plan\`/\`summary\` describe how *that* task was worked — they
are context, never a map of the current codebase. Never use another task's
write-ups to guess where code lives or how it's shaped; open the actual files and
read them directly. (That's why \`list_tasks\`/\`search_tasks\` omit those
fields — they're only on the task you \`get_task\` directly.)

**Ask the board a question; don't download it.** \`list_tasks\` and
\`search_tasks\` filter server-side — by status, board/project, assignee, text,
and by activity window: \`statusChangedFrom\`/\`To\` (what moved),
\`completedFrom\`/\`To\` (what shipped), \`updatedFrom\`/\`To\`. A bare
\`YYYY-MM-DD\` means that whole day, and \`from = to\` is a valid single-day
window. \`actor\` narrows to who actually *did* the work (the activity log) —
that, not \`assignee\`, is what "what did I do today" means. Reach for
\`detail: "full"\` only when you truly need the working fields. A read that
still doesn't fit comes back with a \`_truncation\` block naming what it had to
drop — \`cut\` lists the fields that lost rows, \`truncatedFields\` the ones whose
text was shortened — and the filters that would narrow it. Use those rather than
re-running the same wide call. A read that reports \`response_too_large\` returned
nothing at all: narrow it before trying again.

The steps below are **composable** — not every task needs every one. Depending
on what's asked, you might do just the analysis, just the technical plan
(analysis first), build directly, or the whole chain end to end. Whichever
artifacts you produce, record them on the task (\`analysisSummary\`, \`plan\`,
\`summary\`).

1. **Analyze** — think the non-trivial parts
   through. Set \`status: "analyzing"\`, then write the free-text field
   \`analysisSummary\` via \`update_task\` (the **Analysis** — what & why, the
   approach, trade-offs). **Write it for a reader who won't open the code** —
   whoever picks the task up may not be technical. Stay as no-code as you can:
   lead with what changes for the user, and describe the code in plain words
   rather than file paths, symbol names, or jargon. You must still convey the
   code reality — what already exists and is **reused**, what's genuinely
   **new**, what's a **duplicate** or merely **relocated**, what's deliberately
   **out of scope**, and any **risk** — just say it in words a non-coder can act
   on. Save the file-level, step-by-step detail for the Technical Plan. Keep it
   concise, a short write-up that scales with the work; length is the driver's
   call. When this is settled, **ask first — "Can I mark this as analyzed?" —
   and only set \`status: "analyzed"\` once the user confirms** (a valid resting
   state — understood, not yet built). Never flip it to analyzed on your own; the
   user may want to review or check something first.
2. **Technical Plan** (optional) — the concrete plan that will be implemented.
   Not every task needs one, but whenever a plan is produced (e.g. you ask
   Claude to plan the task), it belongs here: paste the actual step-by-step plan
   Claude will execute into the free-text field \`plan\` via \`update_task\` — the
   plan itself, not a summary of it. An analysis normally precedes it. A task
   can validly **stop here** — plan written, not yet built. This is the
   **Analyzed → Building** handoff and doesn't change status on its own.
3. **Build** — set \`status: "building"\` and execute the plan. When the code is
   written but not yet signed off, set \`status: "review"\` — a resting state
   meaning "built, awaiting a look" (a valid place to stop).
4. **Finish** — write a short \`summary\` of what was done (you can use
   \`git log\`/\`git diff\` to help), plus the context the diff can't show (the
   why, key decisions, gotchas, follow-ups) — give any scope added along the way
   its own line. Keep it concise; length is the driver's call. Then **ask first —
   "Can I mark this as done?" — and only mark the task done (\`complete_task\`)
   once the user confirms**. Never mark it done just because the code is
   written; the user may want to view or visually check something first.
   \`update_task\` will refuse \`status: "done"\` for this reason — completion goes
   through \`complete_task\`.
5. **Subtasks close first.** A parent is done when everything under it is, so
   \`complete_task\` refuses a task with unfinished subtasks and names them. Close
   those (each with its own confirmation), or — only if the user asked to finish
   the whole branch — pass \`withSubtasks: true\`. The rule runs the other way too:
   nesting unfinished work under a done task reopens it.

## Notes are DISCONTINUED

The notes feature is **gone** — task notes, decisions, standup callouts, review
items and canvas sticky notes alike. There is no \`add_note\`, \`list_notes\` or
\`resolve_note\` tool, no \`notes\` field on a task, and no notes table. If an
older \`CLAUDE.md\`, prompt or habit tells you to add or resolve a note, that
instruction is stale: **say so and don't try** — nothing will accept the call.

Write what you would have noted where it now belongs: a decision or a trade-off
goes in the task's \`analysisSummary\` or \`plan\`, what shipped and its gotchas
go in its \`summary\`, a passing remark goes in a comment (\`add_comment\`), and
anything the user wants to check later is its own task. If the user asks you to
"note" or "flag" something, ask which of those they mean rather than inventing a
place for it.
`;

/*
  The WORK DAY contract — the second half of the process, on the same terms as
  WORKFLOW above: one constant, every surface derives from it (the MCP
  instructions, the `finish_work` prompt, and the Finish work view's copy). The
  steps a person reads and the steps an agent follows cannot drift apart.

  WORKFLOW is about one task's journey. This is about one day's record.
*/
export const DAY_CLOSE = `# Working days

A **working day** is one person's day on one project — what to report at the
standup. Two moments produce something; nothing else is required.

**Nothing starts a day.** There is no clock-in. A day exists because there was
work in it, and if nobody presses anything the record is still correct — the
digest reads the event log, not the day. Both rituals below buy you an
*artifact*, so skipping them costs you the artifact and never the data.

**A working day runs 04:00 → 04:00 local**, not midnight to midnight. Finishing
something at 01:00 is the end of a long evening, so it counts for the previous
day. Never reason about "today" from a raw timestamp — the day a moment belongs
to is decided in one place (\`lib/workday.ts\`) and every read agrees with it.

## Ready for the day → the snapshot

\`ready_for_day\` freezes what the todo looks like right now. That list is
otherwise lost: THIS WEEK is a mutable bucket, so by evening the morning's plan has
been edited past recognition, and "was my list clear enough?" becomes
unanswerable. Pressing it again overwrites — the last arrangement of the morning
is the real commitment.

It is **not** a crediting boundary. It changes no dates. That's what makes it
safe to skip.

## Finish work → the standup

\`work_day\` returns everything the close-out needs; \`finish_work\` records the
result. Walk it with the user:

0. **Any earlier day left open?** \`openDays\` lists working days with their work
   on them that were never closed out. Raise those FIRST — an unclosed day is work
   missing from the record, and since nothing nags about it, saying so here is the
   only thing that catches it. Offer to close them before today's.
1. **Which of these finished?** \`candidates\` are tasks they actually touched
   that day, still sitting in a late work status. Proposals, not conclusions —
   each one still goes through \`complete_task\` with its own \`summary\` and its
   own confirmation. **Never bulk-complete a day's work**; batch the *asking*,
   never the deciding.
2. **What did you do that isn't here?** Work that leaves no trace — a call, a
   conversation, an errand — cannot be found by reconciling the board, so it has
   to be asked for. \`log_past_work\` turns each one into a real task, already
   done, credited to that day and filed into DONE THIS WEEK so it never sits in a
   triage lane. One record for everything.
3. **Check the dates.** Anything credited to a day other than the one it was
   recorded on should be visible, not implied.
4. **Write the standup.** Write it from the tasks themselves — their summaries
   are what shipped. List what shipped with one-line summaries, say what's still
   in flight, and flag anything that looks stuck; keep \`handled\` separate from \`shipped\` — say "handled",
   never "built"; report \`closedUnattributed\` as tasks cleared off the board,
   never as someone's work. Pass it as \`summary\`, with any non-task points
   ("out Thursday") as \`bullets\`. Keep it tight enough to paste into a channel.

When \`drift\` is present, it's worth a line: \`doneNotPlanned\` is the day's real
interruptions, and it's usually the most honest thing in the update.

## Drafted, then sealed

\`finish_work\` leaves the day **drafted** — written up, and still correctable.
That matters because the standup itself is where the day gets reviewed: things
get split, something turns out to have been finished. All of that still lands on
that day.

A day **seals itself** once a later day is drafted. Nothing to press. So
yesterday stays open through the standup and shuts the moment today is finished.
Past that, late work is credited to the current day and *labelled* as clearing
older work — never back-filled into a standup that has already been presented.
\`finish_work\` refuses a sealed day for that reason.
`;

/*
  The third contract, and the only one that looks outward at the code.

  WORKFLOW is one task's journey. DAY_CLOSE is one day's record. This is the
  BOARD's state — the ritual that reconciles what the board claims against what
  the repo actually shows, whenever the two have drifted apart.

  Delivered the same three ways as the others: the MCP `instructions`, the
  `todo://cleanup` resource, and the `clean_up_todo` prompt.
*/
export const BOARD_CLEANUP = `# Cleaning up the board

\`board_review\` returns **evidence, never conclusions**: what's in flight, what
moved in the window, what's been sitting still, whether each task has an
analysis / plan / summary, and what commits are linked. It cannot know whether the work is done. **Only the repo knows that.**

So a cleanup is a **reconciliation**, the same move as the Finish step, over
three sources in this order: (1) what the board claims, (2) what the code shows —
\`git log\`, the diff, the actual files — and (3) what the user decides.

**Every flag is a question, not a finding.** \`buildingNoCommits\` might mean
stalled work, or work on a branch, or work that needs no commit at all. Open the
code and find out. Never propose an action from a flag alone, and never repeat a
flag back as though it were a conclusion.

**Read the code directly.** Another task's \`plan\` or \`summary\` is not a map of
where code lives — that rule holds here more than anywhere, because a cleanup
touches many tasks at once and the temptation to skim is proportional.

**\`scope.gitFolder\` says where this project's code lives**, and it may be null
because nobody recorded it. If the code isn't on this machine, say so plainly and
confine yourself to board hygiene — placement, a missing plan or summary, how
long something has sat. Never claim what the code does from a board read.
\`elsewhere\` is on-going work in other projects, refs only: mention it so it
isn't invisible, offer to review it, don't reason about it.

**One table, then one decision at a time.** Present what you found as a single
table — ref · title · status/placement · days idle · what the board claims · what
the code shows · what you propose · the evidence for it. Then batch the *asking*
and never the deciding: anything that completes or closes a task goes through
\`complete_task\` with its own \`summary\` and its own confirmation. Filing moves
(placement, re-ending) may go through \`bulk_apply\` once the user has said yes to
the batch.

**Pass \`expectedUpdatedAt\`** from the review on every \`update_task\`. A review
is a snapshot, and the user edits the board too — sometimes while you're talking.

**A cleanup that finds nothing to change is a good outcome.** Say the board is
honest. Never invent progress, or a tidying move, to justify having run the pass.
`;
