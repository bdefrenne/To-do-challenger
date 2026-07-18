"use client";

/**
 * "Assign" trigger + keyboard-navigable assign popover for canvas Section task
 * cards. Hidden until you hover the card (or while the popover is open), so the
 * card stays clean. Open it by clicking the button, or by pressing the **A**
 * keystroke while hovering the card. Opening focuses a filter input:
 *
 *   • type      — filter the roster by name
 *   • ↑ / ↓     — move the highlight
 *   • Enter     — toggle the highlighted person (stays open → multi-assign)
 *   • Esc       — close
 *
 * Distinct from the always-inline <AssigneeEditor/> (used in the task modal):
 * that one has no filter/keyboard nav and shows an "Unassigned" affordance,
 * which the canvas card deliberately omits.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { usePeople } from "@/components/PeopleContext";
import { PersonAvatar } from "@/components/PersonAvatar";
import { AnchoredPopover } from "./AnchoredPopover";
import { useCardShortcut } from "./useCardShortcut";

export function QuickAssign({
  taskId,
  assigneeIds,
  onChange,
  className = "",
  memberIds,
  onEditMembers,
}: {
  taskId: string;
  assigneeIds: string[];
  onChange: (id: string, patch: { assigneeIds: string[] }) => void;
  /** Extra classes for the root (e.g. `ml-auto` to push it to the card edge). */
  className?: string;
  /** Restrict the pickable people to these roster user ids (the task's project
   *  members). Empty/undefined ⇒ the whole roster (fallback). */
  memberIds?: string[];
  /** When set, shows an "Edit Project Members" button at the bottom. */
  onEditMembers?: () => void;
}) {
  const { people } = usePeople();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const has = (id: string) => assigneeIds.includes(id);

  // Scope to project members when set, but always keep anyone already assigned
  // (e.g. an auto-assigned task creator who isn't a member). No members ⇒ the
  // whole roster (fallback).
  const candidates = useMemo(
    () =>
      memberIds && memberIds.length
        ? people.filter(
            (p) => memberIds.includes(p.id) || assigneeIds.includes(p.id),
          )
        : people,
    [people, memberIds, assigneeIds],
  );

  const filtered = useMemo(() => {
    const n = query.trim().toLowerCase();
    return n
      ? candidates.filter((p) => p.name.toLowerCase().includes(n))
      : candidates;
  }, [candidates, query]);

  const openFresh = () => {
    setQuery("");
    setActive(0);
    setOpen(true);
  };

  // The "A" keystroke opens this popover when its card is hovered.
  useCardShortcut(rootRef, "a", openFresh);

  // Focus the filter input on open (query/highlight are reset by the opener).
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Keep the highlighted row scrolled into view during arrow navigation.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const toggle = (id: string) => {
    const next = has(id) ? assigneeIds.filter((a) => a !== id) : [...assigneeIds, id];
    onChange(taskId, { assigneeIds: next });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const p = filtered[active];
      if (p) toggle(p.id);
    }
  };

  return (
    <div
      ref={rootRef}
      // Hidden until card-hover, but forced visible while the popover is open so
      // it doesn't vanish when the cursor leaves the card mid-assign.
      className={[
        "relative shrink-0 transition-opacity",
        open ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      // The card is HTML5-draggable; don't let interactions here start a drag.
      onDragStart={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title="Assign (press A while hovering the card)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);
          else openFresh();
        }}
        className={[
          "flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium transition-colors",
          open
            ? "border-accent bg-accent-soft text-accent"
            : "border-border bg-surface-2 text-muted hover:border-accent hover:text-accent",
        ].join(" ")}
      >
        Assign
        <kbd className="rounded bg-surface-3 px-1 text-[9px] font-semibold leading-none text-faint">
          A
        </kbd>
      </button>

      <AnchoredPopover
        open={open}
        anchorRef={rootRef}
        onClose={() => setOpen(false)}
        align="right"
        className="w-52 rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0); // filtering reflows the list — re-highlight the top
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a name…"
          className="mb-1 w-full rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        />
        <div ref={listRef} className="max-h-48 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-faint">No matches.</p>
          ) : (
            filtered.map((p, i) => {
              const on = has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    toggle(p.id);
                    inputRef.current?.focus();
                  }}
                  className={[
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
                    i === active ? "bg-surface-2" : "",
                  ].join(" ")}
                >
                  <PersonAvatar name={p.name} size={18} />
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
            className="mt-1 flex w-full items-center gap-1.5 border-t border-border px-2 py-1.5 text-left text-xs font-medium text-accent hover:bg-surface-2"
          >
            <span className="text-sm leading-none">⚙</span>
            Edit Project Members
          </button>
        ) : null}
      </AnchoredPopover>
    </div>
  );
}
