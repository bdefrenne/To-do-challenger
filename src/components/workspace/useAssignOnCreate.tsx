"use client";

/**
 * "Assign to <name>", offered by every composer that can run under an assignee
 * filter (TD2-193).
 *
 * The problem it solves: a view narrowed to one person creates tasks with
 * nobody on them, so a card typed into a filtered list, column or canvas
 * section disappears at the moment it is created — the composer looks broken,
 * and the task is somewhere the person can't see it. So the create carries the
 * person being filtered for, and the checkbox is ON by default: what you type
 * into someone's filtered view is, overwhelmingly, for them.
 *
 * A hook rather than a component because it owns both halves — the control and
 * the value it produces — and three composers (list row, board column, canvas
 * section) need both. Nothing renders when no filter is on.
 */

import { useState } from "react";
import { usePeople } from "@/components/PeopleContext";

export function useAssignOnCreate(assigneeId: string | null): {
  /** The checkbox, or null when nothing is filtered. Render it under the input. */
  control: React.ReactNode;
  /** What to hand the create call — undefined when there's nothing to add. */
  assigneeIds: string[] | undefined;
} {
  const { resolveById } = usePeople();
  // Which filter the current tick of the box was an answer to. Switching the
  // filter to someone else re-arms it, WITHOUT an effect: unticking the box for
  // Sam says nothing about what you want when you switch to Alex.
  const [answer, setAnswer] = useState<{ for: string | null; on: boolean }>({
    for: assigneeId,
    on: true,
  });
  const on = answer.for === assigneeId ? answer.on : true;

  if (!assigneeId) return { control: null, assigneeIds: undefined };

  const name = resolveById(assigneeId)?.name ?? "them";
  return {
    control: (
      <label
        // The composer often sits inside a draggable canvas card or a row with
        // its own click handling; the label must not reach either.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="mt-1 flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted"
      >
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setAnswer({ for: assigneeId, on: e.target.checked })}
          className="h-3 w-3 cursor-pointer accent-[var(--color-accent)]"
        />
        Assign to {name}
      </label>
    ),
    assigneeIds: on ? [assigneeId] : undefined,
  };
}
