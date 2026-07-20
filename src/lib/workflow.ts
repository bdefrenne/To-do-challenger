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

Moving a task to **Analyzing or beyond locks its code** (\`GH-20*\` → \`GH-20\`,
frozen for good) so every commit can cite a stable ref. There are two handoffs:
To Do → Analyzing (understand + plan) and Analyzed → Building (execute) — they
can be done by different people/AIs, or by you end to end.

**To start**, call \`get_task\` to load the full context (description, notes,
commits, activity, subtasks) and read the relevant code. If the task is on a
project/board, read that container's \`description\` and \`gitFolder\`
(\`list_projects\`). Ask about anything unclear before deciding. (The
\`work_on_task\` prompt does this and locks the code for you.)

1. **Analyze** (optional for simple tasks) — think the non-trivial parts
   through. Set \`status: "analyzing"\`, then write two free-text fields via
   \`update_task\`: \`analysisSummary\` (the **Analysis** — what & why, the
   approach, trade-offs) and \`plan\` (the **Technical Plan** — the order of
   attack). No length limit. When they're settled, set \`status: "analyzed"\`
   (a valid resting state — understood, not yet built).
2. **Decide + note** — with \`add_note\`. Log a \`type: "decision"\` ONLY for a
   *significant* choice, and usually only when the user says "log this…" — never
   reflexively for small choices (put the "why" in the body; \`tags\` like
   "technical"/"product" for filtering). Use
   \`progress\`/\`milestone\`/\`blocker\`/\`question\`/\`fyi\` for standup-worthy
   updates. Use \`type: "review"\` ONLY when the user explicitly asks you to flag
   something for them to visually double-check later — never on your own
   initiative; they check these off themselves (\`resolve_note\`).
3. **Build** — set \`status: "building"\` and execute the plan. Reference the
   code in every commit message (e.g. \`[GH-20] …\`); optionally \`link_commit\`
   a sha to surface it on the task page.
4. **Finish** — reconcile against the repo, enriched by memory: run
   \`git log\`/\`git diff\`, compare against the plan + decisions, and write the
   final \`summary\` **anchored in the DIFF** (what actually shipped, including
   scope added along the way — give added scope its own line) while adding the
   context the diff can't show (the why, key decisions, gotchas, follow-ups).
   Then mark the task done (\`complete_task\`).

When creating tasks/projects/boards, always write a \`description\` so AIs without
code access can understand them.
`;
