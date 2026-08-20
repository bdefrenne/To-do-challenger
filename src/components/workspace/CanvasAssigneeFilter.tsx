"use client";

/**
 * Canvas header control (TD-59) — show only one assignee's cards across every
 * section on the board. Purely a client-side render filter: no Liveblocks
 * write, no server round-trip (see CanvasEditor's `filterAssigneeId` prop and
 * SectionNode's resize guard for why that matters). A dropdown picks anyone on
 * the roster; the "Me" pill is a one-click shortcut for the common case.
 */

import { Check, ChevronDown } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { usePeople } from "@/components/PeopleContext";
import { PersonAvatar } from "@/components/PersonAvatar";
import { AnchoredPopover } from "./AnchoredPopover";

export function CanvasAssigneeFilter({
  value,
  onChange,
}: {
  /** Selected assignee id, or null for "everyone" (no filter). */
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { people, me } = usePeople();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const n = query.trim().toLowerCase();
    return n ? people.filter((p) => p.name.toLowerCase().includes(n)) : people;
  }, [people, query]);

  const selected = value ? people.find((p) => p.id === value) : undefined;

  const openFresh = () => {
    setQuery("");
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div ref={rootRef} className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openFresh())}
        title="Show only one assignee's tasks, across every group on this canvas"
        className={[
          "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
          selected
            ? "border-accent bg-accent-soft text-accent"
            : "border-border bg-surface-2 text-muted hover:border-accent hover:text-accent",
        ].join(" ")}
      >
        {selected ? (
          <>
            <PersonAvatar name={selected.name} size={16} />
            {selected.name}
          </>
        ) : (
          "Everyone"
        )}
        <ChevronDown aria-hidden size={13} strokeWidth={2} className="text-faint" />
      </button>

      {me ? (
        <button
          type="button"
          onClick={() => onChange(value === me.id ? null : me.id)}
          title="Show only my tasks"
          className={[
            "flex h-7 items-center rounded-md border px-2 text-xs font-medium transition-colors",
            value === me.id
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface-2 text-muted hover:border-accent hover:text-accent",
          ].join(" ")}
        >
          Me
        </button>
      ) : null}

      <AnchoredPopover
        open={open}
        anchorRef={rootRef}
        onClose={() => setOpen(false)}
        align="left"
        className="w-52 rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a name…"
          className="mb-1 w-full rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        />
        <div className="max-h-56 overflow-y-auto">
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={[
              "flex w-full items-center rounded-md px-2 py-1 text-left text-xs",
              value === null ? "bg-surface-2" : "",
            ].join(" ")}
          >
            <span className="flex-1 text-fg">Everyone</span>
            {value === null ? <span className="text-accent"><Check aria-hidden size={13} strokeWidth={2.5} /></span> : null}
          </button>
          {filtered.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-faint">No matches.</p>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                }}
                className={[
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
                  value === p.id ? "bg-surface-2" : "",
                ].join(" ")}
              >
                <PersonAvatar name={p.name} size={18} />
                <span className="flex-1 truncate text-fg">{p.name}</span>
                {value === p.id ? <span className="text-accent"><Check aria-hidden size={13} strokeWidth={2.5} /></span> : null}
              </button>
            ))
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}
