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

**To start**, call \`get_task\` to load the full context (description, notes,
commits, activity, subtasks) and read the relevant code. Ask about anything unclear before deciding. (The
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
notes to guess where code lives or how it's shaped; open the actual files and
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
still doesn't fit comes back \`truncated\` with the filters that would narrow
it: use them rather than re-running the same wide call.

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
3. **Decide + note** — with \`add_note\`. Log a \`type: "decision"\` ONLY for a
   *significant* choice, and usually only when the user says "log this…" — never
   reflexively for small choices (put the "why" in the body; \`tags\` like
   "technical"/"product" for filtering). Use
   \`progress\`/\`milestone\`/\`blocker\`/\`question\`/\`fyi\` for standup-worthy
   updates. Use \`type: "review"\` ONLY when the user explicitly asks you to flag
   something for them to visually double-check later — never on your own
   initiative; they check these off themselves (\`resolve_note\`).
4. **Build** — set \`status: "building"\` and execute the plan. When the code is
   written but not yet signed off, set \`status: "review"\` — a resting state
   meaning "built, awaiting a look" (a valid place to stop).
5. **Finish** — write a short \`summary\` of what was done (you can use
   \`git log\`/\`git diff\` to help), plus the context the diff can't show (the
   why, key decisions, gotchas, follow-ups) — give any scope added along the way
   its own line. Keep it concise; length is the driver's call. Then **ask first —
   "Can I mark this as done?" — and only mark the task done (\`complete_task\`)
   once the user confirms**. Never mark it done just because the code is
   written; the user may want to view or visually check something first.
   \`update_task\` will refuse \`status: "done"\` for this reason — completion goes
   through \`complete_task\`.
6. **Subtasks close first.** A parent is done when everything under it is, so
   \`complete_task\` refuses a task with unfinished subtasks and names them. Close
   those (each with its own confirmation), or — only if the user asked to finish
   the whole branch — pass \`withSubtasks: true\`. The rule runs the other way too:
   nesting unfinished work under a done task reopens it.
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
4. **Write the standup.** Group the day's notes into **Progress**, **Blockers**,
   **Questions** and **To review** (open \`review\` notes); list what shipped with
   one-line summaries; keep \`handled\` separate from \`shipped\` — say "handled",
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
