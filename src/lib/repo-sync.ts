/*
  Repo ↔ board/project description sync convention.

  A project's / board's `description` is meant to be the SAME text as a Markdown
  file kept in its git working directory (`gitFolder`). The deployed app can't
  read or write your local repos, so this is a *convention*: whoever edits one
  side (the repo file, or the board/project description via the app or the
  `todo` MCP) must update the other. These constants are the single source of
  truth for the filename, the banner that heads the repo file, and the reminder
  text shown across the app + MCP. Change the filename here to change it
  everywhere.
*/

/** The repo file (inside the entity's `gitFolder`) that mirrors its description. */
export const SUMMARY_FILENAME = "DESCRIPTION.md";

/** Banner that MUST head the repo file — spells out the two-way obligation. */
export const SYNC_BANNER = [
  "> **Keep this in sync.** This file mirrors the description of its project/board",
  "> in To-do Challenger. If you edit this file, you MUST update the description",
  "> there too (via the app or the `todo` MCP) — and if you edit it there, you MUST",
  "> update this file. Reference this file from CLAUDE.md so coding agents find it.",
].join("\n");

/** Absolute/relative path of the summary file for a given git folder. */
export function summaryPath(gitFolder: string): string {
  return `${gitFolder.replace(/\/+$/, "")}/${SUMMARY_FILENAME}`;
}

/** Full repo-file content: the banner followed by the shared description. */
export function summaryFileContent(description: string): string {
  return `${SYNC_BANNER}\n\n${description.trim()}\n`;
}

/** One-line reminder embedded in MCP tool text and the UI. */
export const SYNC_NOTE =
  `The description is SHARED with \`<gitFolder>/${SUMMARY_FILENAME}\` in the repo ` +
  `(and should be referenced from CLAUDE.md). If you change one, you MUST update ` +
  `the other.`;
