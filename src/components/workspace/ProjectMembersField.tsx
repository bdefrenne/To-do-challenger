"use client";

/**
 * Roster checklist for a project's members. Membership curates the assignee
 * picker: a task on this project only offers these people (empty ⇒ the whole
 * roster is offered as a fallback). Boards inherit their project's members.
 *
 * Shared workspace: anyone can be added or removed, no one is pinned. On a new
 * project the current user is pre-selected as a convenience (see ProjectModal),
 * but they can be toggled off like anyone else.
 */

import { Check } from "lucide-react";
import { usePeople } from "@/components/PeopleContext";
import { PersonAvatar } from "@/components/PersonAvatar";

export function ProjectMembersField({
  selected,
  onChange,
}: {
  /** Currently-selected member user ids. */
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { people } = usePeople();
  const has = (id: string) => selected.includes(id);

  const toggle = (id: string) =>
    onChange(has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-muted">
        Members{" "}
        <span className="text-faint">
          (who can be assigned to this project&rsquo;s tasks — none ⇒ everyone)
        </span>
      </span>
      <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-bg p-1">
        {people.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-faint">No users yet.</p>
        ) : (
          people.map((p) => {
            const on = has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
              >
                <PersonAvatar name={p.name} size={20} />
                <span className="flex-1 truncate text-fg">{p.name}</span>
                {on ? <span className="text-accent"><Check aria-hidden size={13} strokeWidth={2.5} /></span> : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
