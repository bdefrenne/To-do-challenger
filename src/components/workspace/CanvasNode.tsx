"use client";

/**
 * One element on the canvas — a markdown `text` block or a `section` (board).
 * Purely presentational: all pointer math (drag/select/marquee) lives in
 * CanvasEditor, which supplies `onPointerDown`. In view mode a text node renders
 * via the shared <Markdown/>; in edit mode it's a raw-markdown <textarea> with
 * list auto-continue on Enter (type "- " and each Enter keeps the bullet going)
 * and Tab / Shift+Tab to indent / outdent (nest) the current line(s).
 */

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Markdown } from "@/components/ui/Markdown";
import type { CanvasNode as CanvasNodeT } from "@/lib/types";
import { SectionNode } from "./SectionNode";
export { NEW_SECTION_SIZE } from "./SectionNode";

/** Default geometry for freshly-dropped nodes (canvas units). */
export const NEW_TEXT_SIZE = { width: 360, height: 64 };

/** Floor height for a text card — roughly one line plus padding. The card is
 *  otherwise content-sized (`height: auto`), so this is what lets it shrink. */
const MIN_TEXT_HEIGHT = 40;

/** Continue or end a markdown list when Enter is pressed inside the textarea.
 *  Returns the new value + caret, or null to fall through to a plain newline. */
function listContinuation(
  value: string,
  caret: number,
): { value: string; caret: number } | null {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const line = value.slice(lineStart, caret);
  const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  if (!m) return null;
  const [, indent, marker, rest] = m;
  // Empty item → end the list (clear the marker on this line).
  if (rest.trim() === "") {
    const next = value.slice(0, lineStart) + value.slice(caret);
    return { value: next, caret: lineStart };
  }
  // Continue the list: numbered markers increment, bullets repeat.
  const numbered = marker.match(/^(\d+)([.)])$/);
  const nextMarker = numbered
    ? `${Number(numbered[1]) + 1}${numbered[2]}`
    : marker;
  const insert = `\n${indent}${nextMarker} `;
  const next = value.slice(0, caret) + insert + value.slice(caret);
  return { value: next, caret: caret + insert.length };
}

/** One indent level. Spaces, never a tab: a literal `\t` at line-start makes
 *  Markdown treat the line as a code block, so nested bullets need spaces. */
const INDENT = "  ";

/** Indent (or, with `outdent`, un-indent) every line touched by the selection,
 *  returning the new value and adjusted selection range. Un-indent strips up to
 *  one level (2 spaces, or a stray tab) from each line's start. */
function indentSelection(
  value: string,
  selStart: number,
  selEnd: number,
  outdent: boolean,
): { value: string; selStart: number; selEnd: number } {
  const firstLineStart = value.lastIndexOf("\n", selStart - 1) + 1;
  const before = value.slice(0, firstLineStart);
  const region = value.slice(firstLineStart, selEnd);
  const after = value.slice(selEnd);

  let deltaFirst = 0; // chars added/removed on the first line (shifts selStart)
  let deltaTotal = 0; // cumulative change across all lines (shifts selEnd)
  const lines = region.split("\n").map((line, i) => {
    if (outdent) {
      const removed = line.match(/^( {1,2}|\t)/)?.[0].length ?? 0;
      if (i === 0) deltaFirst = -removed;
      deltaTotal -= removed;
      return line.slice(removed);
    }
    if (i === 0) deltaFirst = INDENT.length;
    deltaTotal += INDENT.length;
    return INDENT + line;
  });

  return {
    value: before + lines.join("\n") + after,
    selStart: Math.max(firstLineStart, selStart + deltaFirst),
    selEnd: selEnd + deltaTotal,
  };
}

export function CanvasNode({
  node,
  selected,
  editing,
  smooth = true,
  onPointerDown,
  onStartEditing,
  onChange,
  onStopEditing,
  onPatch,
  onResize,
  onLinkStart,
  canvasName = "",
  isMaster = false,
  masterSection = null,
  onSetMaster,
  onRemove,
}: {
  node: CanvasNodeT;
  selected: boolean;
  editing: boolean;
  /** Ease position changes (for remote moves). Off while YOU drag it, so your
   *  own dragging stays glued to the cursor with no rubber-banding. */
  smooth?: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onStartEditing: () => void;
  onChange: (content: string) => void;
  onStopEditing: () => void;
  /** Patch arbitrary node fields (used by section nodes for data.boardId). */
  onPatch?: (patch: { content?: string; data?: Record<string, unknown> }) => void;
  /** Report a text card's measured height so stored `node.height` can follow. */
  onResize?: (height: number) => void;
  /** Begin a link drag from a text node's port (→ drop on a task to link it). */
  onLinkStart?: (e: ReactPointerEvent) => void;
  /** The parent canvas's name — a section uses it to name a new project. */
  canvasName?: string;
  /** Section-only: this section is its board's master (Send target). */
  isMaster?: boolean;
  /** Section-only: the master section for this section's board, if any and not
   *  this one — the target of its "Send to top of …" button. */
  masterSection?: { id: string; name: string } | null;
  /** Section-only: mark/unmark this section as its board's master. */
  onSetMaster?: (master: boolean) => void;
  /** Section-only: remove this node from the canvas (after sending its cards). */
  onRemove?: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const isSection = node.kind === "section";

  // Focus + select all the text whenever we enter edit mode, so a double-click
  // re-edit lets you replace the content with the next keystroke (or click once
  // to place the caret). Runs both immediately and on the next frame so it wins
  // over the click that created/opened the node (autoFocus covers the
  // create-mount case; this covers re-editing). On an empty new node select() is
  // a no-op, so the caret just sits at the start.
  useEffect(() => {
    if (!editing) return;
    const focus = () => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.select();
    };
    focus();
    const raf = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  // Grow the textarea to fit its content while editing (it's `resize-none` and
  // no longer `h-full`, so we drive its height here). The auto-height card then
  // follows, and the ResizeObserver below commits the new height to storage.
  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [editing, node.content]);

  // Mirror the text card's rendered height back into stored `node.height`, so
  // persistence, multiplayer, marquee hit-testing, and selection rings follow
  // the content. Latest height/callback live in refs so the observer is created
  // once (the editor re-renders often — cursors, presence). The round-guard
  // avoids write loops and jitter.
  const onResizeRef = useRef(onResize);
  const heightRef = useRef(node.height);
  useEffect(() => {
    onResizeRef.current = onResize;
    heightRef.current = node.height;
  });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (Math.round(h) !== Math.round(heightRef.current)) onResizeRef.current?.(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const base: React.CSSProperties = {
    position: "absolute",
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    // Glide to new positions when the move came from someone else.
    transition: smooth ? "left 90ms linear, top 90ms linear" : undefined,
  };

  if (isSection) {
    return (
      <SectionNode
        node={node}
        selected={selected}
        onPointerDown={onPointerDown}
        onPatch={onPatch ?? (() => {})}
        onResize={onResize}
        canvasName={canvasName}
        isMaster={isMaster}
        masterSection={masterSection}
        onSetMaster={onSetMaster}
        onRemove={onRemove}
      />
    );
  }

  return (
    <div
      ref={boxRef}
      // Content-driven height: the card sizes to its text (grows and shrinks),
      // and `onResize` mirrors that into stored `node.height`. `minHeight` (not
      // `node.height`) is the floor, which is what lets it shrink back down.
      style={{ ...base, height: "auto", minHeight: MIN_TEXT_HEIGHT }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEditing();
      }}
      className={[
        "group/text overflow-visible rounded-lg border bg-surface p-2 shadow-sm",
        selected ? "border-accent ring-1 ring-accent" : "border-border",
        editing ? "cursor-text" : "cursor-grab active:cursor-grabbing",
      ].join(" ")}
    >
      {editing ? (
        <textarea
          ref={taRef}
          autoFocus
          value={node.content}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onStopEditing}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onStopEditing();
              return;
            }
            if (e.key === "Tab") {
              // Indent / outdent instead of letting Tab blur the textarea
              // (that blur is what used to "commit" and surprise-render a bullet).
              e.preventDefault();
              const ta = e.currentTarget;
              const res = indentSelection(
                ta.value,
                ta.selectionStart,
                ta.selectionEnd,
                e.shiftKey,
              );
              onChange(res.value);
              requestAnimationFrame(() => {
                ta.setSelectionRange(res.selStart, res.selEnd);
              });
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              const ta = e.currentTarget;
              const cont = listContinuation(ta.value, ta.selectionStart);
              if (cont) {
                e.preventDefault();
                onChange(cont.value);
                requestAnimationFrame(() => {
                  ta.setSelectionRange(cont.caret, cont.caret);
                });
              }
            }
          }}
          placeholder="Type…  ('- ' for a bullet, '# ' for a heading)"
          className="block w-full resize-none overflow-hidden bg-transparent text-sm leading-relaxed text-fg outline-none"
        />
      ) : (
        // Let pointer events fall through to the card so double-click-to-edit
        // (and drag) work when you click the text itself, not just the padding.
        // Links stay clickable.
        <div className="pointer-events-none [&_a]:pointer-events-auto">
          {node.content.trim() ? (
            <Markdown>{node.content}</Markdown>
          ) : (
            <span className="text-sm text-faint">Empty — double-click to edit</span>
          )}
        </div>
      )}

      {/* Link port — drag from here onto a task card to connect the two.
          Hidden until you hover the note (or grab the port). */}
      {onLinkStart && !editing ? (
        <button
          type="button"
          title="Drag to a task to link it"
          aria-label="Link to a task"
          onPointerDown={(e) => {
            e.stopPropagation();
            onLinkStart(e);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute -right-2.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full border-2 border-accent bg-surface text-accent opacity-0 shadow-sm transition-opacity hover:bg-accent hover:text-white group-hover/text:opacity-100"
        >
          <span aria-hidden className="text-[11px] leading-none">→</span>
        </button>
      ) : null}
    </div>
  );
}
