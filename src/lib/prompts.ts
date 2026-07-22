/*
  Ready-to-paste clipboard prompts for handing a task to an AI.

  Each is a slim handoff that points at the canonical todo workflow contract
  (see `src/lib/workflow.ts` — delivered as the MCP server instructions and the
  `todo://workflow` resource) rather than restating it, so they can't drift from
  the source of truth. Kept self-sufficient for a client that has only the todo
  tools connected.

  - `analyzePrompt`         — the **Analyze** step only; think it through, don't build.
  - `planPrompt`            — the **Technical Plan** step only (analysis must exist).
  - `workPrompt`            — hand it off to build (assumes the code is locked).
  - `analyzeThenWorkPrompt` — analyze → work → finish, end to end.
*/

/** Analyze only: load context, think it through, record the analysis — no build. */
export function analyzePrompt(code: string, title: string): string {
  return (
    `I want to ANALYZE with you the task ${code} — "${title}" using the "todo" MCP. ` +
    `We'll brainstorm it, do not build it yet.\n\n` +
    `Start with get_task to load full context and read the relevant code in any relevant repo.` +
    `Follow the **Analyze** step of the todo workflow contract — it's in the MCP ` +
    `server instructions and the todo://workflow resource (read it if you haven't). ` +
    `Set status to "analyzing", ask me anything unclear, then when it's settled ` +
    `write the \`analysisSummary\` (what & why — written so a non-coder can ` +
    `follow it; no-code where it can be) ` +
    `via update_task — keep it concise — and set status to "analyzed". Stop ` +
    `there — don't start building until I hand it to you.`
  );
}

/** Technical Plan only: an analysis already exists, write the plan — no build. */
export function planPrompt(code: string, title: string): string {
  return (
    `I want you to write the TECHNICAL PLAN for task ${code} — "${title}" using ` +
    `the "todo" MCP. An analysis already exists — do not re-analyze, and do not ` +
    `build it yet.\n\n` +
    `Start with get_task to load full context (read the existing \`analysisSummary\`) ` +
    `and read the relevant code in any relevant repo. ` +
    `Follow the **Technical Plan** step of the todo workflow contract — it's in ` +
    `the MCP server instructions and the todo://workflow resource (read it if you ` +
    `haven't). Ask me anything unclear, then write the \`plan\` via update_task — ` +
    `the actual step-by-step plan you'll execute, not a summary of it. Stop there ` +
    `— don't start building until I hand it to you.`
  );
}

/** Work handoff: build it (assumes the code is locked). */
export function workPrompt(code: string, title: string): string {
  return (
    `I want you to build task ${code} — "${title}" using the "todo" MCP.\n\n` +
    `Start with get_task to load full context and read the relevant code in any relevant repo. and follow the todo workflow contract — it's in the MCP server ` +
    `instructions and the todo://workflow resource (read it if you haven't). In ` +
    `short: set status to "building", add_note only for significant decisions or ` +
    `standup-worthy updates (when I ask), and run the finish protocol (write a ` +
    `short summary of what shipped — you can diff git to help — and mark done) ` +
    `when we're done.`
  );
}

/** Full run: analyze first, then work through to done. */
export function analyzeThenWorkPrompt(code: string, title: string): string {
  return (
    `I want you to take task ${code} — "${title}" from analysis through to done, ` +
    `using the "todo" MCP.\n\n` +
    `Start with get_task to load full context and read the relevant code. Follow ` +
    `the todo workflow contract (MCP server instructions / todo://workflow ` +
    `resource — read it if you haven't). Move it along the status spine as you go:\n` +
    `1. **Analyze** (status "analyzing") — think it through, ask me anything ` +
    `unclear, then write \`analysisSummary\` (what & why — written so a non-coder ` +
    `can follow it; no-code where it can be) via update_task — keep it ` +
    `concise — and set status "analyzed".\n` +
    `2. **Technical Plan** — write \`plan\` via update_task: the actual step-by-step ` +
    `plan you'll execute, not a summary of it.\n` +
    `3. **Build** (status "building") — execute the plan; add_note for significant ` +
    `decisions or standup-worthy updates.\n` +
    `4. **Finish** — write a short \`summary\` of what actually shipped (you can ` +
    `diff git to help; call out any added scope), and mark it done.`
  );
}
