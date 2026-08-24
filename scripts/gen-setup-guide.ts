/**
 * Regenerates `src/lib/todoSetupGuide.ts` from `docs/todo-mcp-setup.md`.
 *
 * The doc is the source of truth; the TS module exists only because the deployed
 * app can't read the repo — Settings hands the text to a teammate's coding agent.
 * Run `npm run gen:setup-guide` after editing the doc.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "docs/todo-mcp-setup.md";
const OUT = "src/lib/todoSetupGuide.ts";

// The "Mirror" blockquote is a note to us about keeping the two files in step —
// it's noise for the agent being handed the guide, so it doesn't travel.
const md =
  readFileSync(SRC, "utf8")
    .replace(/^> \*\*Mirror\.\*\*[\s\S]*?(?=\n\n)\n\n/m, "")
    .replace(/\s+$/, "") + "\n";
const escaped = md
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

writeFileSync(
  OUT,
  `/**
 * The agent-facing setup guide, handed to a teammate's coding agent so their repo
 * starts working from the todo board.
 *
 * GENERATED from \`${SRC}\` by \`npm run gen:setup-guide\` — edit the doc, not this file.
 */
export const TODO_SETUP_GUIDE = \`${escaped}\`;
`,
);

console.log(`Wrote ${OUT} (${md.length} chars of markdown)`);
