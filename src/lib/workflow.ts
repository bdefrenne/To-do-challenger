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

    Backlog → To Do → Analyzing → Analyzed → Building → Done

Moving a task to **Analyzing or beyond locks its code** (\`GH-20*\` → \`GH-20\`) —
a stable, permanent ref for the task. There are two handoffs: To Do → Analyzing
(understand + analysis) and Analyzed → Building (tech plan + execute) — they can be done by
different people/AIs, or by you end to end.

**To start**, call \`get_task\` to load the full context (description, notes,
commits, activity, subtasks) and read the relevant code. Ask about anything unclear before deciding. (The
\`work_on_task\` prompt does this and locks the code for you.)

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
   call. When this is settled, set \`status: "analyzed"\` (a valid resting state
   — understood, not yet built).
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
4. **Build** — set \`status: "building"\` and execute the plan.
5. **Finish** — write a short \`summary\` of what was done (you can use
   \`git log\`/\`git diff\` to help), plus the context the diff can't show (the
   why, key decisions, gotchas, follow-ups) — give any scope added along the way
   its own line. Keep it concise; length is the driver's call. Then mark the
   task done (\`complete_task\`).
`;
