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

**To start**, call \`get_task\` to load the full context (description, notes,
commits, activity, subtasks) and read the relevant code. If the task is on a
project/board, read that container's \`description\` and \`gitFolder\`
(\`list_projects\`). Ask about anything unclear before deciding. (The
\`work_on_task\` prompt does this and locks the code for you.)

1. **Analyze (optional)** — for anything non-trivial, think it through first.
   When the analysis is settled, you may write \`analysisSummary\` and set
   \`analyzedAt\` via \`update_task\`. Simple tasks can skip this entirely.
2. **Decide + note** — capture the choices and callouts that actually matter with
   \`add_note\`: use \`type: "decision"\` for a real decision (put the "why" in the
   body; \`tags\` like "technical"/"product" for filtering), or
   \`progress\`/\`milestone\`/\`blocker\`/\`question\`/\`fyi\` for standup-worthy
   updates. Don't log reflexively — record decisions when they're significant or
   when the user asks you to.
3. **Work** — write a short \`plan\` (\`update_task\`) if it helps, then build. Lock
   the code first if it's still soft (\`lock_task\`; \`work_on_task\` already did
   this) so commits can cite it — reference it in every commit message and
   \`link_commit\` each sha.
4. **Finish** — reconcile, don't recollect: run \`git log\`/\`git diff\`, compare
   against the plan + notes, write the final \`summary\` from the DIFF — not from
   memory — then mark the task done (\`complete_task\`).

When creating tasks/projects/boards, always write a \`description\` so AIs without
code access can understand them.
`;
