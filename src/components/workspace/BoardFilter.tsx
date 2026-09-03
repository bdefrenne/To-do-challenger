"use client";

/**
 * Show only some of a project's boards (TD2-216) — the multi-select twin of
 * `AssigneeFilter`, and the same deal: a client-side render filter, no write,
 * no round-trip.
 *
 * Multi-select where the assignee filter is single, because the question is a
 * different shape: "whose is this?" has one answer, "which of these am I
 * looking at today?" has several. `null` means ALL boards — not "every id I can
 * see right now" — so a board added tomorrow shows up instead of being silently
 * filtered out (see `useProjectFilters`).
 *
 * It offers only the boards it is given, which is the project's VISIBLE set:
 * a board that's been put away (TD2-213) isn't work you're choosing between.
 */

import { Check, ChevronDown } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { Board } from "@/lib/types";
import { Avatar } from "@/components/ui/Badge";
import { AnchoredPopover } from "./AnchoredPopover";

export function BoardFilter({
  boards,
  value,
  onChange,
}: {
  /** The boards on offer, in the order every other view draws them. */
  boards: Board[];
  /** Selected board ids, or null for "all boards" (no filter). */
  value: string[] | null;
  onChange: (ids: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const n = query.trim().toLowerCase();
    return n ? boards.filter((b) => b.name.toLowerCase().includes(n)) : boards;
  }, [boards, query]);

  const selected = useMemo(() => (value ? new Set(value) : null), [value]);
  const count = selected ? selected.size : boards.length;

  /** Toggling one board OFF turns "all" into an explicit list, which is the
   *  only place the sentinel is expanded — and toggling the last one back on
   *  collapses it to "all" again, so the selection doesn't quietly become a
   *  frozen list of today's boards. */
  const toggle = (id: string) => {
    const next = new Set(selected ?? boards.map((b) => b.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (next.size === 0) return; // showing nothing is never what was meant
    onChange(next.size === boards.length ? null : [...next]);
  };

  const openFresh = () => {
    setQuery("");
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const label = !selected
    ? "All boards"
    : count === 1
      ? (boards.find((b) => selected.has(b.id))?.name ?? "1 board")
      : `${count} of ${boards.length} boards`;

  return (
    <div ref={rootRef} className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openFresh())}
        title="Show only some of this project's boards"
        className={[
          "flex h-7 max-w-56 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
          selected
            ? "border-accent bg-accent-soft text-accent"
            : "border-border bg-surface-2 text-muted hover:border-accent hover:text-accent",
        ].join(" ")}
      >
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden size={13} strokeWidth={2} className="shrink-0 text-faint" />
      </button>

      <AnchoredPopover
        open={open}
        anchorRef={rootRef}
        onClose={() => setOpen(false)}
        align="left"
        className="w-56 rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a board name…"
          className="mb-1 w-full rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        />
        <div className="max-h-56 overflow-y-auto">
          {/* Stays open: picking boards is several clicks, and closing on the
              first one would make "all but that one" a four-trip job. */}
          <button
            type="button"
            onClick={() => onChange(null)}
            className={[
              "flex w-full items-center rounded-md px-2 py-1 text-left text-xs",
              !selected ? "bg-surface-2" : "",
            ].join(" ")}
          >
            <span className="flex-1 text-fg">All boards</span>
            {!selected ? (
              <span className="text-accent">
                <Check aria-hidden size={13} strokeWidth={2.5} />
              </span>
            ) : null}
          </button>
          {filtered.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-faint">No matches.</p>
          ) : (
            filtered.map((b) => {
              const on = !selected || selected.has(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => toggle(b.id)}
                  className={[
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
                    on && selected ? "bg-surface-2" : "",
                  ].join(" ")}
                >
                  <Avatar name={b.name} size={18} imageUrl={b.image} color={b.color} />
                  <span className="flex-1 truncate text-fg">{b.name}</span>
                  {on ? (
                    <span className={selected ? "text-accent" : "text-faint"}>
                      <Check aria-hidden size={13} strokeWidth={2.5} />
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}
