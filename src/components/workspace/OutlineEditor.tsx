"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type OutlineRow, descOwnerAt } from "@/lib/outline";
import { RemoteCaret } from "./RemoteCaret";

/** A peer sitting in one outline row. */
export type OutlinePeer = { name: string; color: string; caret?: number; len?: number };

/**
 * The outline ("text view") editor — the rows themselves.
 *
 * Pure presentation: one line per row, indented by its level, titles as plain
 * lines and descriptions as italic blocks. Every behaviour (what Enter, Tab and
 * Backspace do, and how rows become real tasks) lives in `useOutlineDraft`, so
 * the canvas Section and the project Boards view render the identical editor over
 * their own lists.
 *
 * Rows are editable by everyone at once — a row is one task FIELD, so two people
 * on different rows never collide. `peers` therefore only decorates: a ring in
 * their colour on the row they're in, their caret inside it, and an amber ring on
 * the one case that genuinely can't merge — both people in the SAME field, where
 * the last write wins.
 */
export function rowFieldKey(rows: OutlineRow[], index: number): string | null {
  const row = rows[index];
  if (!row) return null;
  if (!row.desc) return row.taskId;
  const owner = descOwnerAt(rows, index);
  return owner?.taskId ? `${owner.taskId}#desc` : null;
}

/** Every row's field key in ONE pass. Calling `rowFieldKey` per row is O(N²) —
 *  each desc row walks back up the list to find its owner — and this runs on every
 *  keystroke, so it walks forward once instead and remembers the last task seen. */
export function rowFieldKeys(rows: OutlineRow[]): (string | null)[] {
  let lastTaskId: string | null = null;
  return rows.map((r) => {
    if (!r.desc) {
      lastTaskId = r.taskId;
      return r.taskId;
    }
    return lastTaskId ? `${lastTaskId}#desc` : null;
  });
}

function AutoGrowTextarea({
  value,
  capped,
  registerRef,
  onChange,
  onKeyDown,
  onCaretMove,
  placeholder,
  className,
  peers,
}: {
  value: string;
  capped: boolean;
  registerRef: (el: HTMLTextAreaElement | null) => void;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCaretMove?: (offset: number, len: number) => void;
  placeholder: string;
  className: string;
  peers: OutlinePeer[];
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Re-render once on mount so a caret mounted with us gets a real element to
  // measure against instead of null.
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  const MAX_ROWS = 6;
  const resize = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    if (capped) {
      const lh = parseFloat(getComputedStyle(node).lineHeight) || 20;
      const max = lh * MAX_ROWS;
      node.style.maxHeight = `${max}px`;
      node.style.height = `${Math.min(node.scrollHeight, max)}px`;
      node.style.overflowY = node.scrollHeight > max ? "auto" : "hidden";
    } else {
      node.style.maxHeight = "none";
      node.style.height = `${node.scrollHeight}px`;
      node.style.overflowY = "hidden";
    }
  }, [capped]);
  useLayoutEffect(resize, [value, capped, resize]);

  // Publishing our own caret: `selectionchange` on the element isn't universal,
  // so read it off the events that can move it. The throttle lives in the caller.
  const report = (e: { currentTarget: HTMLTextAreaElement }) => {
    if (!onCaretMove) return;
    const node = e.currentTarget;
    onCaretMove(node.selectionStart ?? 0, node.value.length);
  };

  return (
    <div className="relative flex-1">
      <textarea
        ref={(node) => {
          ref.current = node;
          setEl(node);
          registerRef(node);
        }}
        value={value}
        rows={1}
        onChange={(e) => {
          onChange(e);
          resize();
          report(e);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={report}
        onFocus={report}
        onClick={report}
        onSelect={report}
        placeholder={placeholder}
        className={className}
      />
      {peers.map((p, i) =>
        p.caret === undefined ? null : (
          <RemoteCaret
            key={`${p.name}:${i}`}
            target={el}
            text={value}
            offset={p.caret}
            color={p.color}
            name={p.name}
          />
        ),
      )}
    </div>
  );
}

export function OutlineEditor({
  rows,
  inputRefs,
  descCapped,
  onText,
  onKeyDown,
  peers,
  myField,
  onCaret,
}: {
  rows: OutlineRow[];
  inputRefs: React.MutableRefObject<Map<string, HTMLInputElement | HTMLTextAreaElement>>;
  /** Cap description rows at 6 visible rows (then scroll); false = grow unbounded. */
  descCapped: boolean;
  onText: (key: string, text: string) => void;
  onKeyDown: (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    row: OutlineRow,
    index: number,
  ) => void;
  /** Who else is in which field, keyed by `rowFieldKey`. Absent = single-user
   *  surface (the Boards view has no room), and everything below is skipped. */
  peers?: Map<string, OutlinePeer[]>;
  /** The field WE are in, so a shared one can be called out. */
  myField?: string | null;
  /** Report our caret so peers can draw it. Throttling is the caller's job. */
  onCaret?: (field: string | null, offset: number, len: number) => void;
}) {
  const fields = useMemo(() => rowFieldKeys(rows), [rows]);
  return (
    <div className="space-y-0.5">
      {rows.map((row, i) => {
        const pad = row.indent * 16;
        const setRef = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
          if (el) inputRefs.current.set(row.key, el);
          else inputRefs.current.delete(row.key);
        };
        const field = fields[i];
        const here = (field && peers?.get(field)) || [];
        // Both of us in one field is the single case that can't merge — the last
        // write wins and someone's characters go. Say so instead of hiding it.
        const collision = !!field && !!myField && field === myField && here.length > 0;
        const ring = here[0];
        const report = onCaret
          ? (offset: number, len: number) => onCaret(field, offset, len)
          : undefined;
        return (
          <div
            key={row.key}
            className="flex items-start gap-1.5 rounded"
            style={{
              paddingLeft: pad,
              boxShadow: collision
                ? "inset 0 0 0 1.5px #f59e0b"
                : ring
                  ? `inset 0 0 0 1.5px ${ring.color}`
                  : undefined,
            }}
            title={
              collision
                ? `${ring?.name ?? "Someone"} is typing here too — last edit wins`
                : ring
                  ? `${ring.name} is editing this line`
                  : undefined
            }
          >
            {row.desc ? null : (
              <span className="mt-0.5 shrink-0 select-none text-xs text-muted">–</span>
            )}
            {row.desc ? (
              // A description is a plain multiline block — italic, no label. It
              // grows to fit its (wrapped) content, capped at 6 rows unless the
              // section header toggles "show all". Enter = newline, Shift+Tab
              // pops a line out (see onRowKeyDown).
              <AutoGrowTextarea
                registerRef={setRef}
                value={row.text}
                capped={descCapped}
                onChange={(e) => onText(row.key, e.target.value)}
                onKeyDown={(e) => onKeyDown(e, row, i)}
                onCaretMove={report}
                peers={here}
                className="w-full resize-none bg-transparent text-sm italic leading-snug text-muted outline-none"
                placeholder="description…"
              />
            ) : (
              // A title wraps onto multiple lines when long, but stays single-
              // value: the task-row branch of onRowKeyDown preventDefaults Enter
              // (→ new task row), so no literal newline is ever inserted.
              <AutoGrowTextarea
                registerRef={setRef}
                value={row.text}
                capped={false}
                onChange={(e) => onText(row.key, e.target.value)}
                onKeyDown={(e) => onKeyDown(e, row, i)}
                onCaretMove={report}
                peers={here}
                className="w-full resize-none bg-transparent text-sm leading-snug text-fg outline-none"
                placeholder="task…"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
