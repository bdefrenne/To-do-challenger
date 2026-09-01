/**
 * Reading a project's boards when some of them are hidden (TD2-213).
 *
 * `listProjects` hands a project's boards back in two arrays — `boards` for the
 * ones it shows, `hiddenBoards` for the ones put away — so that hiding a board
 * needs no cooperation from the surfaces that render it. Every view already
 * iterates `project.boards`, so every view hides them for free, and a view
 * written next year inherits the same default instead of having to remember a
 * filter it has never heard of.
 *
 * The helper below is the deliberate exception, and the distinction it draws is
 * the whole point:
 *
 *   • "Which boards does this project SHOW?" — its columns, its lanes, its
 *     sidebar entries, the boards a picker offers. Read `project.boards`.
 *     NEVER this.
 *   • "What is the board with this id CALLED?" — a task on a hidden board is
 *     still in the Trash, still in the Archived view, still a row in the task
 *     table, and still has a page of its own that must load. Read this.
 *
 * A name lookup that goes through `project.boards` doesn't hide anything; it
 * just renders "No board" against a task whose board is right there, which
 * reads as data loss rather than as a board being put away.
 */

import type { Board, Project } from "./types";

/** Every board of a project, hidden ones last. For NAME and NAVIGATION lookups
 *  only — see the note above before reaching for it. */
export const allBoards = (p: Pick<Project, "boards" | "hiddenBoards">): Board[] => [
  ...(p.boards ?? []),
  ...(p.hiddenBoards ?? []),
];

/** The board with this id, hidden ones included, across every project. The
 *  shared body of the several "name this board" lookups. */
export function findBoard(
  projects: readonly Project[],
  boardId: string | null | undefined,
): { board: Board; project: Project } | null {
  if (!boardId) return null;
  for (const project of projects) {
    const board = allBoards(project).find((b) => b.id === boardId);
    if (board) return { board, project };
  }
  return null;
}
