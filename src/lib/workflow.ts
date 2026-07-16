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

**Getting a task's context IS how you start it.** There are three fetch tools —
use the right one:
- \`get_task\` — a passive PEEK (headline fields + activity, no working context).
  Use only when you are NOT about to act.
- \`get_task_for_analysis\` — call this to START analysing. It returns the FULL
  context, locks the code so commits can cite it, and stamps \`analysisStartedAt\`.
- \`get_task_for_working\` — call this to START building (after analysis). It
  returns the plan + decisions + locked code and stamps \`workStartedAt\`.

Do NOT analyze or build off a plain \`get_task\` — it deliberately withholds the
working context, so the only way to get what you need is the phase tool, and
fetching it is what records that you began. (\`work_on_task\` is a convenience
prompt that calls \`get_task_for_analysis\` for you.)

1. **Understand** — \`get_task_for_analysis\` loads the task, its
   comments/decisions/notes; then read the relevant code. If it's on a
   project/board, read that container's \`description\` and \`gitFolder\`
   (\`list_projects\`). Ask about anything unclear before deciding.
2. **Analyze** — \`record_decision\` for EACH choice as it happens (business/product/
   ux/technical/scope; \`scope\` = capability added on the fly with no task of its
   own). Your start time was already stamped when you fetched the analysis
   context (a first \`record_decision\` is only a set-if-null backstop). When
   analysis is settled, write \`analysisSummary\` and set \`analyzedAt\` via
   \`update_task\`.
3. **Work** — call \`get_task_for_working\` to load the build context; that stamps
   \`workStartedAt\`. Write a short \`plan\` (\`update_task\`), then build. The code is
   already locked, so reference it in EVERY commit message and \`link_commit\` each
   sha (a set-if-null backstop for \`workStartedAt\`). Keep recording decisions;
   log anything added on the fly as a \`scope\` decision.
4. **Surface** — \`add_note\` anything standup-worthy (blockers, milestones, questions).
5. **Finish** — reconcile, don't recollect: run \`git log\`/\`git diff\` since work
   started, compare against the plan + decisions, capture anything shipped that
   isn't recorded (especially on-the-fly scope), write the final \`summary\` from
   the DIFF — not from memory — then mark the task done (\`complete_task\`).

When creating tasks/projects/boards, always write a \`description\` so AIs without
code access can understand them.
`;
