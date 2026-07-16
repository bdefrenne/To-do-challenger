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

**Before touching anything** — read the task (\`get_task\`) and, if it belongs to a
project/board, that container's \`description\` and \`gitFolder\` (\`list_projects\`).
Ask about anything unclear before deciding.

1. **Understand** — load the task, its comments/decisions/notes, and the relevant code.
2. **Analyze** — \`record_decision\` for EACH choice as it happens (business/product/
   ux/technical/scope; \`scope\` = capability added on the fly with no task of its
   own). The first decision auto-starts the analysis clock. When analysis is
   settled, write \`analysisSummary\` and set \`analyzedAt\` via \`update_task\`.
3. **Work** — lock the code so it's citable (\`lock_task\`; handoff via
   \`work_on_task\` does it for you). Write a short \`plan\` (\`update_task\`), then
   build. Reference the code in EVERY commit message and \`link_commit\` each sha.
   Keep recording decisions; log anything added on the fly as a \`scope\` decision.
4. **Surface** — \`add_note\` anything standup-worthy (blockers, milestones, questions).
5. **Finish** — reconcile, don't recollect: run \`git log\`/\`git diff\` since work
   started, compare against the plan + decisions, capture anything shipped that
   isn't recorded (especially on-the-fly scope), write the final \`summary\` from
   the DIFF — not from memory — then mark the task done (\`complete_task\`).

When creating tasks/projects/boards, always write a \`description\` so AIs without
code access can understand them.
`;
