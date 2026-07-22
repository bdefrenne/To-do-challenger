"use client";

/**
 * Assign/unassign real users. Opens a dropdown of the roster; toggling a person
 * persists the new assignee-name list via the supplied `onChange`. Extracted
 * from TaskDetailModal so the canvas Section cards can share the exact picker.
 */

import { useEffect, useRef, useState } from "react";
import { usePeople } from "@/components/PeopleContext";
import { PersonAvatar, AvatarStack } from "@/components/PersonAvatar";

export function AssigneeEditor({
  taskId,
  assigneeIds,
  onChange,
  memberIds,
  onEditMembers,
}: {
  taskId: string;
  assigneeIds: string[];
  onChange: (id: string, patch: { assigneeIds: string[] }) => void;
  /** Restrict the pickable people to these roster user ids (the task's project
   *  members). Empty/undefined ⇒ the whole roster (fallback). */
  memberIds?: string[];
  /** When set, shows an "Edit Project Members" button at the bottom (opens the
   *  task's project settings). Only passed for tasks that belong to a project. */
  onEditMembers?: () => void;
}) {
  const { people, resolveById } = usePeople();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Scope to project members when set, but always keep anyone already assigned
  // (e.g. an auto-assigned task creator who isn't a member) so they stay
  // manageable. No members set ⇒ offer the whole roster.
  const candidates =
    memberIds && memberIds.length
      ? people.filter(
          (p) => memberIds.includes(p.id) || assigneeIds.includes(p.id),
        )
      : people;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const has = (id: string) => assigneeIds.includes(id);
  const toggle = (id: string) => {
    const next = has(id)
      ? assigneeIds.filter((a) => a !== id)
      : [...assigneeIds, id];
    onChange(taskId, { assigneeIds: next });
  };
  const label = assigneeIds.map((id) => resolveById(id)?.name ?? "?").join(", ");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-surface"
      >
        {assigneeIds.length ? (
          <>
            <AvatarStack ids={assigneeIds} size={20} />
            <span className="truncate text-fg">{label}</span>
          </>
        ) : (
          <span className="text-faint">Unassigned — click to assign</span>
        )}
        <span className="ml-auto text-faint">▾</span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 z-40 mt-1 rounded-lg border border-border bg-surface py-1 shadow-lg">
          <div className="max-h-56 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="px-3 py-2 text-xs text-faint">No members yet.</p>
            ) : (
              candidates.map((p) => {
                const on = has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggle(p.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                  >
                    <PersonAvatar name={p.name} size={20} />
                    <span className="flex-1 truncate text-fg">{p.name}</span>
                    {on ? <span className="text-accent">✓</span> : null}
                  </button>
                );
              })
            )}
          </div>
          {onEditMembers ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onEditMembers();
              }}
              className="mt-1 flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-xs font-medium text-accent hover:bg-surface-2"
            >
              <span className="text-sm leading-none">⚙</span>
              Edit Project Members
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
