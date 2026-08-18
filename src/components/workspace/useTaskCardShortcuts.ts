import type { RefObject } from "react";
import { useCardShortcut } from "./useCardShortcut";
import { useWorkspace } from "./WorkspaceContext";

/**
 * THE task-card hover shortcuts — one definition, every surface.
 *
 * Every handler comes straight from the workspace, so the canvas Section card,
 * the kanban card and the table row behave identically by construction rather
 * than by three lists being kept in sync. The keys are hover-scoped and fired in
 * capture — see `useCardShortcut` — so a card always beats the canvas editor's
 * own single-key tools, and beats page scroll for the arrows.
 *
 * `CARD_SHORTCUTS` below is the source both this hook and the cheatsheet read, so
 * what the help panel promises is what's actually registered.
 */
export const CARD_SHORTCUTS = [
  { keys: ["D"], label: "Done ⇄ Building" },
  { keys: ["S"], label: "Status picker" },
  { keys: ["I"], label: "Importance picker" },
  { keys: ["A"], label: "Assignee picker" },
  { keys: ["1", "2"], label: "Importance: Elevated · High" },
  { keys: ["Space"], label: "Assign / unassign yourself" },
  { keys: ["Delete", "⌫"], label: "Delete — done or in review: park in DONE THIS WEEK" },
  { keys: ["↑"], label: "Send to THIS WEEK" },
  { keys: ["→"], label: "Send to BACKLOG" },
  { keys: ["↓"], label: "Send to LATER" },
] as const;

/**
 * Wire the set to one card.
 *
 * @param id     the hovered card's task id (null while a row is uncommitted)
 * @param triage false on a read-only log (the Done view): D and the pickers still
 *               work, but nothing re-files or removes a card.
 *
 * Where the card currently SITS — which decides what DELETE means, see
 * `deletionOf` — is the workspace's answer, not the view's: a mounted canvas reads
 * its own nodes, everything else reads the pin (`placementOf`). So no surface has
 * to tell us, and none of them can disagree.
 */
export function useTaskCardShortcuts(
  ref: RefObject<HTMLElement | null>,
  id: string | null,
  { triage = true }: { triage?: boolean } = {},
) {
  const {
    taskMap,
    openTaskIds,
    toggleDone,
    setStatus,
    editTask,
    toggleSelfAssignee,
    deleteTask,
    sendToPlacement,
  } = useWorkspace();

  // A task modal owns the keyboard while it's up. The overlay covers the viewport,
  // so a card behind it isn't `:hover` and mostly can't fire — but that's a CSS
  // detail holding back DELETE, and it doesn't hold during the tick the overlay
  // mounts or unmounts. Gate on the modal itself, as the canvas editor does.
  const live = (fn: () => void) => () => {
    if (openTaskIds.length) return;
    fn();
  };

  // "D": not-done → done (the checkbox's /complete path, so it's credited to
  // today); done → building, which clears completedAt.
  useCardShortcut(
    ref,
    "d",
    live(() => {
      if (!id) return;
      if (taskMap[id]?.status === "done") setStatus(id, "building");
      else toggleDone(id);
    }),
  );
  useCardShortcut(ref, "1", live(() => id && editTask(id, { importance: 1 })));
  useCardShortcut(ref, "2", live(() => id && editTask(id, { importance: 2 })));
  useCardShortcut(ref, " ", live(() => id && toggleSelfAssignee(id)));

  const del = live(() => id && triage && deleteTask(id));
  useCardShortcut(ref, "delete", del);
  useCardShortcut(ref, "backspace", del);

  // Laid out the way the groups sit on the canvas: UP to this week's work, RIGHT
  // to the backlog, DOWN to later.
  const send = (to: "thisWeek" | "backlog" | "later") =>
    live(() => id && triage && sendToPlacement(id, to));
  useCardShortcut(ref, "arrowup", send("thisWeek"));
  useCardShortcut(ref, "arrowright", send("backlog"));
  useCardShortcut(ref, "arrowdown", send("later"));
}
