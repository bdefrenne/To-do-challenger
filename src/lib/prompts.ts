/*
  Ready-to-paste clipboard prompts for handing a task to an AI.

  Each is a slim handoff that points at the canonical todo workflow contract
  (see `src/lib/workflow.ts` — delivered as the MCP server instructions and the
  `todo://workflow` resource) rather than restating it, so they can't drift from
  the source of truth. Kept self-sufficient for a client that has only the todo
  tools connected.

  - `analyzePrompt`         — the **Analyze** step only; think it through, don't build.
  - `workPrompt`            — hand it off to build (assumes the code is locked).
  - `analyzeThenWorkPrompt` — analyze → work → finish, end to end.
*/

/** Analyze only: load context, think it through, record the analysis — no build. */
export function analyzePrompt(code: string, title: string): string {
  return (
    `I want you to ANALYZE task ${code} — "${title}" using the "todo" MCP. ` +
    `Think it through — don't build yet.\n\n` +
    `Start with get_task to load full context and read the relevant code (and the ` +
    `project's description + gitFolder via list_projects if it's on a board). ` +
    `Follow the **Analyze** step of the todo workflow contract — it's in the MCP ` +
    `server instructions and the todo://workflow resource (read it if you haven't). ` +
    `Set status to "analyzing", ask me anything unclear, then when it's settled ` +
    `write the \`analysisSummary\` (what & why) and \`plan\` (the technical plan) ` +
    `via update_task and set status to "analyzed". Stop there — don't start ` +
    `building until I hand it to you.`
  );
}

/** Work handoff: build it, citing the (now locked) code in commits. */
export function workPrompt(code: string, title: string): string {
  return (
    `I want you to build task ${code} — "${title}" using the "todo" MCP.\n\n` +
    `Start with get_task to load full context (including its Analysis + Technical ` +
    `Plan), and follow the todo workflow contract — it's in the MCP server ` +
    `instructions and the todo://workflow resource (read it if you haven't). In ` +
    `short: set status to "building", reference ${code} in every commit, add_note ` +
    `only for significant decisions or standup-worthy updates (when I ask), and ` +
    `run the finish protocol (reconcile the git diff — enriched from memory — ` +
    `write the summary from what shipped, mark done) when we're done.`
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
    `unclear, then write \`analysisSummary\` (what & why) + \`plan\` (the technical ` +
    `plan) via update_task and set status "analyzed".\n` +
    `2. **Build** (status "building") — its code is locked, so reference ${code} ` +
    `in every commit; add_note for significant decisions or standup-worthy updates.\n` +
    `3. **Finish** — reconcile against the git diff (enriched from memory), write ` +
    `the \`summary\` from what actually shipped (call out any added scope), and ` +
    `mark it done.`
  );
}
