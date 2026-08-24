"use client";

import { useEffect, useState } from "react";
import { CARD_SHORTCUTS } from "./useTaskCardShortcuts";
import { useWorkspace } from "./WorkspaceContext";

/** Event the sidebar's "Keyboard shortcuts" item fires — decoupled so a menu item
 *  anywhere can open the panel without owning its state. */
const SHORTCUTS_EVENT = "shortcuts:open";

/** Open the cheatsheet from anywhere (the sidebar menu). */
export const openShortcutsHelp = () =>
  window.dispatchEvent(new Event(SHORTCUTS_EVENT));

/**
 * The canvas's own single-key tools. Unlike `CARD_SHORTCUTS` these can't be read
 * off the implementation (they're a `switch` in CanvasEditor's keydown handler),
 * so they're transcribed — keep the two in step: CanvasEditor.tsx, "keyboard".
 */
const CANVAS_SHORTCUTS = [
  { keys: ["V"], label: "Select" },
  { keys: ["T"], label: "Text" },
  { keys: ["S"], label: "Section of tasks" },
  { keys: ["G"], label: "Section group" },
  { keys: ["P"], label: "Draw" },
  { keys: ["E"], label: "Erase strokes" },
  { keys: ["F"], label: "Frame selection (or the whole canvas)" },
  { keys: ["Space"], label: "Hold to pan" },
  { keys: ["⌘Z", "⇧⌘Z"], label: "Undo · redo (undoes a card delete first)" },
] as const;

/**
 * The open task modal's own keys. Transcribed like `CANVAS_SHORTCUTS` (they live
 * in TaskDetailModal's keydown handler) — keep the two in step.
 */
const MODAL_SHORTCUTS = [
  { keys: ["D"], label: "Done ⇄ Building" },
  { keys: ["Esc"], label: "Close (one level at a time)" },
] as const;

/**
 * The keyboard cheatsheet, opened with **?** from anywhere.
 *
 * The card half is generated from `CARD_SHORTCUTS`, the list `useTaskCardShortcuts`
 * documents itself with — so the panel can't promise a key that isn't registered.
 * Mounted once in the AppShell, because the card keys work on every surface that
 * draws a task card (canvas, the project Boards view, a board's kanban, the task
 * table), not just on the canvas.
 */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);
  const { openTaskIds } = useWorkspace();

  // Opened from the sidebar menu too — a keyboard cheatsheet nobody can find by
  // keyboard is the problem it exists to solve.
  useEffect(() => {
    const onAsk = () => setOpen(true);
    window.addEventListener(SHORTCUTS_EVENT, onAsk);
    return () => window.removeEventListener(SHORTCUTS_EVENT, onAsk);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setOpen(false);
      if (e.key !== "?") return;
      // "?" is a literal character in a text field, and a task modal owns the
      // keyboard while it's up — the same two guards the card keys use.
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      )
        return;
      if (openTaskIds.length) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTaskIds]);

  if (!open) return null;
  return (
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-[400] flex items-center justify-center bg-slate-900/30 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="max-h-full w-full max-w-3xl overflow-y-auto rounded-xl border border-border bg-surface p-6 shadow-xl"
      >
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-base font-semibold tracking-tight text-fg">
            Keyboard shortcuts
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="text-xs text-faint transition-colors hover:text-fg"
          >
            Esc
          </button>
        </div>
        <div className="grid gap-8 sm:grid-cols-2">
          <Group
            title="Hovering a task card"
            hint="Anywhere a card is drawn — canvas, Boards, kanban, the task list."
            rows={CARD_SHORTCUTS}
          />
          <Group title="On the canvas" hint="With nothing hovered." rows={CANVAS_SHORTCUTS} />
          <Group
            title="In an open task"
            hint="The card keys stand down while a task modal is up."
            rows={MODAL_SHORTCUTS}
          />
        </div>
      </div>
    </div>
  );
}

function Group({
  title,
  hint,
  rows,
}: {
  title: string;
  hint: string;
  rows: readonly { readonly keys: readonly string[]; readonly label: string }[];
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <p className="mb-3 mt-1 text-xs text-faint">{hint}</p>
      <dl className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-3">
            <dt className="flex shrink-0 gap-1">
              {r.keys.map((k) => (
                <kbd
                  key={k}
                  className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-fg"
                >
                  {k}
                </kbd>
              ))}
            </dt>
            <dd className="text-xs text-muted">{r.label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
