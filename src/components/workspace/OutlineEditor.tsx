"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type OutlineRow, descOwnerAt } from "@/lib/outline";
import type { RowLock } from "./useRowLock";
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
  onFocus,
  onBlurRow,
  readOnly,
  placeholder,
  className,
  peers,
}: {
  value: string;
  capped: boolean;
  registerRef: (el: HTMLTextAreaElement | null) => void;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCaretMove?: (offset: number, len: number, typed?: boolean) => void;
  onFocus?: () => void;
  onBlurRow?: () => void;
  /** A peer is actively typing in this row: visibly theirs, and ours to read. */
  readOnly?: boolean;
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
  const report = (e: { currentTarget: HTMLTextAreaElement }, typed = false) => {
    if (!onCaretMove) return;
    const node = e.currentTarget;
    onCaretMove(node.selectionStart ?? 0, node.value.length, typed);
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
        readOnly={readOnly}
        onChange={(e) => {
          onChange(e);
          resize();
          // `typed`: only a real edit refreshes the lock. Moving the caret must
          // NOT, or parking on a row would hold it indefinitely.
          report(e, true);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={report}
        onFocus={(e) => {
          onFocus?.();
          report(e);
        }}
        onBlur={() => onBlurRow?.()}
        onClick={report}
        onSelect={report}
        placeholder={placeholder}
        className={[className, readOnly ? "cursor-default" : ""].join(" ")}
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
  onCaret,
  lockFor,
  onTakeOver,
  yieldedTo,
  takingField,
  changedField,
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
  /** Report our caret so peers can draw it. Throttling is the caller's job.
   *  `typed` distinguishes a keystroke from merely moving the caret — that is what
   *  lets an idle owner's lock go parked instead of holding a row forever. */
  onCaret?: (field: string | null, offset: number, len: number, typed?: boolean) => void;
  /** Who holds each row. Absent = no room, so no locking at all (Boards view). */
  lockFor?: (field: string | null) => RowLock;
  /** Take a row from its current holder. `pending` is the keystroke that asked
   *  for a parked row — held by the caller and replayed once the row's real text
   *  has arrived, so it is neither lost nor applied to a stale line. */
  onTakeOver?: (field: string, pending?: { insert: string; at: number }) => void;
  /** Someone just took a row from us — named so the row can say who. */
  yieldedTo?: string | null;
  /** A row we have CLAIMED but do not hold yet: the old owner's last characters
   *  are still in flight, so it stays read-only until they land. */
  takingField?: string | null;
  /** A row we just took whose text was not what we had on screen. */
  changedField?: string | null;
}) {
  const fields = useMemo(() => rowFieldKeys(rows), [rows]);
  // Which row is selected, so the takeover control shows on THAT row only —
  // putting it on every locked row would be noise, and it has to appear on
  // selection rather than on a rejected keypress, or the way out is invisible
  // until you have already been blocked.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // A blocked keypress pulses the existing control instead of adding a second
  // mechanism — and proves the key was heard rather than swallowed.
  const [pulseKey, setPulseKey] = useState<string | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulse = useCallback((key: string) => {
    setPulseKey(key);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setPulseKey(null), 600);
  }, []);
  // "You have this line", shown briefly to the taker.
  const [tookField, setTookField] = useState<string | null>(null);
  const tookTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const take = useCallback(
    (field: string, pending?: { insert: string; at: number }) => {
      onTakeOver?.(field, pending);
      setTookField(field);
      if (tookTimer.current) clearTimeout(tookTimer.current);
      tookTimer.current = setTimeout(() => setTookField(null), 2500);
    },
    [onTakeOver],
  );
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
        const lock: RowLock = lockFor?.(field) ?? { state: "free" };
        // A peer holds it and is still typing → read-only. Parked (idle) → theirs
        // on screen, but the first keystroke takes it, so a forgotten caret never
        // holds a row hostage.
        const locked = lock.state === "peer" && lock.live;
        const parked = lock.state === "peer" && !lock.live;
        // Claimed but not yet held: the lock already says "mine", and that is
        // exactly why this can't be read off the lock. Editing has to stay shut
        // until the old owner's text has landed (see `takeOver` in SectionNode).
        const taking = !!field && field === takingField;
        // We took it and it wasn't what we had on screen.
        const moved = !!field && field === changedField;
        // Someone is sitting in OUR row: they are one keystroke from asking for
        // it, so say so before it happens. This is what the old amber "we're
        // colliding" ring becomes — the same condition, an actionable meaning.
        const waiting = lock.state === "mine" && lock.waiting.length > 0 ? lock.waiting[0] : null;
        const selected = selectedKey === row.key;
        const ring = here[0];
        const edge = taking
          ? "#f59e0b"
          : moved
            ? "#10b981"
            : lock.state === "peer"
              ? lock.owner.color
              : waiting
                ? "#f59e0b"
                : ring?.color;
        const report = onCaret
          ? (offset: number, len: number, typed?: boolean) => onCaret(field, offset, len, typed)
          : undefined;
        /** Refuse an edit to a live-locked row: pulse the way out, never swallow
         *  the key silently. On a PARKED row the same keypress takes the row. */
        const guard = (e: React.KeyboardEvent) => {
          if (!field) return false;
          // Already claimed, still waiting on the previous owner's text. Nothing
          // may be typed onto a line we are about to replace.
          if (taking) {
            if (e.key.startsWith("Arrow") || e.key === "Escape") return false;
            e.preventDefault();
            pulse(row.key);
            return true;
          }
          if (parked) {
            // Typing IS the takeover — but the character must not be applied to
            // the text on screen, which is a snapshot of a row we don't own yet.
            // Hold it; `adoptField` replays it onto the real value.
            const printable = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
            if (!printable) {
              take(field);
              return false;
            }
            e.preventDefault();
            const target = e.currentTarget as HTMLInputElement | HTMLTextAreaElement;
            take(field, { insert: e.key, at: target.selectionStart ?? 0 });
            return true;
          }
          if (!locked) return false;
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            take(field);
            return true;
          }
          // Reading and leaving stay usable inside a locked row. Tab does NOT get
          // through: in this editor it re-nests the row, which is an edit to
          // someone else's line, not navigation.
          if (e.key.startsWith("Arrow") || e.key === "Escape") return false;
          e.preventDefault();
          pulse(row.key);
          return true;
        };
        return (
          <div
            key={row.key}
            className="group/row relative flex items-start gap-1.5 rounded transition-shadow"
            style={{
              paddingLeft: pad,
              boxShadow: pulseKey === row.key
                ? "inset 0 0 0 2px #f59e0b"
                : edge
                  ? `inset 0 0 0 1.5px ${edge}`
                  : undefined,
            }}
            title={
              taking
                ? "Taking this line over — waiting for their last characters"
                : moved
                  ? "This line changed while you were waiting — it now shows their version"
                  : lock.state === "peer"
                    ? lock.live
                      ? `${lock.owner.name} is editing this line — ⌘⏎ to take over`
                      : `${lock.owner.name} left their cursor here — just type to take it`
                    : waiting
                      ? `${waiting.name} is waiting for this line`
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
                readOnly={locked || taking}
                onFocus={() => setSelectedKey(row.key)}
                onBlurRow={() => {
                  setSelectedKey((k) => (k === row.key ? null : k));
                  // Leaving a row RELEASES it: the claim is "my caret is here".
                  onCaret?.(null, 0, 0);
                }}
                onChange={(e) => onText(row.key, e.target.value)}
                onKeyDown={(e) => {
                  if (guard(e)) return;
                  onKeyDown(e, row, i);
                }}
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
                readOnly={locked || taking}
                onFocus={() => setSelectedKey(row.key)}
                onBlurRow={() => {
                  setSelectedKey((k) => (k === row.key ? null : k));
                  // Leaving a row RELEASES it: the claim is "my caret is here".
                  onCaret?.(null, 0, 0);
                }}
                onChange={(e) => onText(row.key, e.target.value)}
                onKeyDown={(e) => {
                  if (guard(e)) return;
                  onKeyDown(e, row, i);
                }}
                onCaretMove={report}
                peers={here}
                className="w-full resize-none bg-transparent text-sm leading-snug text-fg outline-none"
                placeholder="task…"
              />
            )}

            {/* Row status, right-aligned so the text never shifts. Several things
                can be true here, and only one shows at a time — ordered by what
                the user most needs to know. */}
            {taking ? (
              // We asked for the row and are waiting on its real text. Says so
              // plainly, because the row is briefly unresponsive on purpose and
              // an unexplained dead textarea reads as a bug.
              <span className="ml-auto shrink-0 pt-0.5 text-[10px] font-semibold text-amber-600">
                taking over…
              </span>
            ) : moved ? (
              // The one case that needs saying: their line was not the line we
              // were looking at. When it matched, this stays silent.
              <span className="ml-auto shrink-0 pt-0.5 text-[10px] font-semibold text-emerald-600">
                updated to their latest
              </span>
            ) : lock.state === "peer" ? (
              <span className="ml-auto flex shrink-0 items-center gap-1 pt-0.5">
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  style={{ backgroundColor: lock.owner.color, opacity: lock.live ? 1 : 0.55 }}
                >
                  ✎ {lock.owner.name}
                </span>
                {/* Only on the row you have SELECTED, and only while they're
                    actively typing — a parked row needs no button, you just type. */}
                {selected && lock.live && field ? (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()} // keep the caret in the row
                    onClick={() => take(field)}
                    className={[
                      "rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-fg",
                      "hover:bg-surface-2",
                      pulseKey === row.key ? "ring-2 ring-amber-500" : "",
                    ].join(" ")}
                  >
                    Take over ⌘⏎
                  </button>
                ) : null}
              </span>
            ) : tookField && field === tookField ? (
              <span className="ml-auto shrink-0 pt-0.5 text-[10px] font-semibold text-emerald-600">
                You have this line
              </span>
            ) : waiting ? (
              <span
                className="ml-auto shrink-0 rounded px-1.5 py-0.5 pt-0.5 text-[10px] font-semibold text-white"
                style={{ backgroundColor: "#f59e0b" }}
                title={`${waiting.name} is waiting for this line`}
              >
                {waiting.name} waiting
              </span>
            ) : null}
          </div>
        );
      })}

      {/* Someone took a row from us — say who, and say it where the eye already
          is rather than in a corner toast. */}
      {yieldedTo ? (
        <div className="pt-1 text-[11px] font-medium text-amber-600">
          {yieldedTo} took over that line — your text was saved.
        </div>
      ) : null}
    </div>
  );
}
