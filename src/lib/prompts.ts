/*
  Ready-to-paste clipboard prompts for handing a task to an AI.

  Each is a slim handoff that points at the canonical todo workflow contract
  (see `src/lib/workflow.ts` — delivered as the MCP server instructions and the
  `todo://workflow` resource) rather than restating it, so they can't drift from
  the source of truth. Kept self-sufficient for a client that has only the todo
  tools connected.

  The three handoffs answer one question — **how much rope do you want?**

  - `analyzePrompt`         — think it through with me; don't build at all.
  - `analyzeThenWorkPrompt` — investigate, tell me what you suggest, wait for my
                              go-ahead, then build it through to done.
  - `workPrompt`            — go ahead and build it now, no check-in first.

  Neither build handoff assumes an analysis or plan already exists — each writes
  whatever's missing as it goes, so any of them works on any task.

  Every prompt opens with the task's title alone on the first line, then a blank
  line, then the handoff itself (see `titleHeader`) — so whatever reads it, a
  chat log or a session list, shows what the work is before anything else. The
  body then cites the task by code alone; the header already said the title.
*/

/** The two working languages a user can pick in their profile. */
export type Language = "en" | "fr";

/** Appended to every prompt for non-French users so the AI works in English. */
export function langSuffix(lang: Language | null | undefined): string {
  return lang === "fr" ? "" : "\n\nWork and talk in ENGLISH.";
}

/**
 * The opening of every task-scoped prompt: the task title on its own line, then
 * a blank line. Keeps the rule in one place — the clipboard handoffs below and
 * the task-scoped MCP slash commands (`src/app/api/mcp/route.ts`) share it.
 */
export function titleHeader(title: string): string {
  return `${title}\n\n`;
}

/** Shared preamble: load the real context before saying anything. */
function loadContext(): string {
  return (
    `Then get_task to load full context and read the relevant code in any ` +
    `relevant repo — read the code directly; don't infer where it lives from ` +
    `other tasks' write-ups. Follow the todo workflow contract — it's in the ` +
    `MCP server instructions and the todo://workflow resource (read it if you ` +
    `haven't). `
  );
}

/** Analyze only: load context, think it through, record the analysis — no build. */
export function analyzePrompt(code: string, title: string, lang?: Language | null): string {
  return (
    titleHeader(title) +
    `I want to ANALYZE with you the task ${code} using the "todo" MCP. ` +
    `We'll brainstorm it, do not build it yet.\n\n` +
    `First, right now, set status to "analyzing" via update_task — we're starting ` +
    `on this together, so do this before anything else. ` +
    loadContext() +
    `Work the **Analyze** step of that contract. ` +
    `Ask me anything unclear, then when it's settled ` +
    `write the \`analysisSummary\` (what & why — written so a non-coder can ` +
    `follow it; no-code where it can be) ` +
    `via update_task — keep it concise. Then ask me "Can I mark this as ` +
    `analyzed?" and only set status to "analyzed" once I confirm — I may want to ` +
    `review or check something first. Stop ` +
    `there — don't start building until I hand it to you.` +
    langSuffix(lang)
  );
}

/**
 * Investigate → propose → (my go-ahead) → build → done.
 *
 * The distinguishing feature vs `workPrompt` is the hard stop after the
 * recommendation: nothing gets written until the user says go.
 */
export function analyzeThenWorkPrompt(code: string, title: string, lang?: Language | null): string {
  return (
    titleHeader(title) +
    `Take task ${code} through to done using the "todo" MCP, ` +
    `but INVESTIGATE FIRST and tell me what you suggest before you implement ` +
    `anything.\n\n` +
    `First, right now, set status to "analyzing" via update_task — we're starting ` +
    `on this, so do this before anything else. ` +
    loadContext() +
    `Then:\n` +
    `1. **Investigate** — work out what's actually going on and what the options ` +
    `are. Ask me anything unclear. Write \`analysisSummary\` (what & why — so a ` +
    `non-coder can follow it; no-code where it can be) via update_task, keep it ` +
    `concise, and set status "analyzed".\n` +
    `2. **Tell me what you suggest** — in chat, give me your recommendation and ` +
    `the shape of the change (what you'd touch, anything risky, anything you'd ` +
    `do differently than I described). Recommend, don't just list options. ` +
    `**Then STOP and wait for my go-ahead — do not write any code yet.**\n` +
    `3. **Build** once I say go — set status "building", write \`plan\` via ` +
    `update_task (the actual step-by-step plan you'll execute, not a summary of ` +
    `it), then execute it.\n` +
    `4. **Finish** — write a short \`summary\` of what actually shipped (you can ` +
    `diff git to help; call out any added scope). Then ask me "Can I mark this as ` +
    `done?" and only mark it done once I confirm — never just because the code is ` +
    `written; I may want to view or visually check something first.` +
    langSuffix(lang)
  );
}

/** Build now: no check-in before implementing (still confirms before done). */
export function workPrompt(code: string, title: string, lang?: Language | null): string {
  return (
    titleHeader(title) +
    `Build task ${code} using the "todo" MCP. ` +
    `You can go ahead directly — no need to check with me before implementing ` +
    `it.\n\n` +
    `First, right now, set status to "building" via update_task — we're starting ` +
    `on this, so do this before anything else. ` +
    loadContext() +
    `Then build it. If there's no \`plan\` on the task yet, write one via ` +
    `update_task first (the actual step-by-step plan you'll execute, not a ` +
    `summary of it) — you don't need my approval on it, just leave it on the ` +
    `record. If something genuinely blocks you, or the task turns out to be much ` +
    `bigger or riskier than it reads, stop and ask me rather than guessing. ` +

    `When it's built, run the finish protocol: write a short \`summary\` of what ` +
    `actually shipped (you can diff git to help; call out any added scope). Then ` +
    `ask me "Can I mark this as done?" and only mark it done once I confirm — ` +
    `never just because the code is written; I may want to view or visually check ` +
    `something first.` +
    langSuffix(lang)
  );
}
