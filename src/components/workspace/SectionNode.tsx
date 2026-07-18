"use client";

/**
 * A canvas Section — a Figma-style titled container bound to a board, whose
 * lines are that board's LIVE tasks. Two modes, ESC is the boundary:
 *
 *   • authoring — a role-cycling line editor. TAB cycles a line task → subtask
 *     → [desc]; SHIFT+TAB reverses. ENTER adds a line of the same role; ENTER on
 *     an empty line pops out one level. Task/subtask lines stay bound to their
 *     task id, so re-editing patches the same task instead of duplicating it.
 *   • committed — the tasks as interactive cards (status, assignees, open, drag).
 *
 * Before it's bound (`data.boardId`) the Section shows a name input that
 * autosuggests existing boards (or creates a new one). Task reads/writes go
 * through useWorkspace(); the commit is one-to-three /api/tasks/bulk batches.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Markdown } from "@/components/ui/Markdown";
import { AvatarStack } from "@/components/PersonAvatar";
import type { CanvasNode as CanvasNodeT, Task } from "@/lib/types";
import {
  type OutlineRow,
  newRow,
  rowsToUnits,
  unitsToRows,
  survivingIds,
  flattenUnits,
  type TaskUnit,
} from "@/lib/outline";
import type { TaskStatus } from "@/lib/types";
import { useWorkspace, type DropPos } from "./WorkspaceContext";
import { QuickAssign } from "./QuickAssign";
import { QuickStatus } from "./QuickStatus";
import { useCardShortcut } from "./useCardShortcut";

export const NEW_SECTION_SIZE = { width: 420, height: 320 };

/** Floor height for a section card so an empty/naming one isn't a sliver. Above
 *  this the card grows to fit its outline/tasks (`height: auto`), and the height
 *  is mirrored back into stored `node.height`. */
const MIN_SECTION_HEIGHT = 140;

const SECTION_DND_MIME = "application/x-section-task";

type Mode = "naming" | "authoring" | "committed";

/** The task TREE for ONE section, read from the live workspace. A section is
 *  scoped by a hidden `customFields.sectionId` tag (not by its board), so a new
 *  section starts empty and several sections can live on the same board without
 *  showing each other's tasks. Arbitrary nesting depth. */
function useSectionUnits(sectionId: string): TaskUnit[] {
  const { nodes, taskMap } = useWorkspace();
  return useMemo(() => {
    const inSection = (id: string) => taskMap[id]?.customFields?.sectionId === sectionId;
    const childrenOf = (parentId: string | null): TaskUnit[] =>
      nodes
        .filter((n) => n.parentId === parentId && inSection(n.id))
        .sort((a, b) => a.position - b.position)
        .map((n) => {
          const t = taskMap[n.id];
          return {
            taskId: n.id,
            title: t?.title ?? "",
            description: t?.description ?? "",
            children: childrenOf(n.id),
          };
        });
    return childrenOf(null);
  }, [sectionId, nodes, taskMap]);
}

export function SectionNode({
  node,
  selected,
  onPointerDown,
  onPatch,
  onResize,
  isMaster = false,
  masterSection = null,
  onSetMaster,
  onRemove,
}: {
  node: CanvasNodeT;
  selected: boolean;
  /** Canvas drag handle — attach to the header only. */
  onPointerDown: (e: ReactPointerEvent) => void;
  /** Persist node fields — the title (content) and data.boardId. */
  onPatch: (patch: { content?: string; data?: Record<string, unknown> }) => void;
  /** Report the section's measured height so stored `node.height` follows content. */
  onResize?: (height: number) => void;
  /** Present for prop-compatibility with CanvasNode; unused now. */
  canvasName?: string;
  /** This section is its board's master — the target of siblings' Send buttons. */
  isMaster?: boolean;
  /** The master section for this section's board (if any and not this one). */
  masterSection?: { id: string; name: string } | null;
  /** Mark/unmark this section as its board's master. */
  onSetMaster?: (master: boolean) => void;
  /** Remove this node from the canvas (used after sending its cards away). */
  onRemove?: () => void;
}) {
  const ws = useWorkspace();
  const boardId = (node.data?.boardId as string | undefined) ?? null;
  // A section's tasks are scoped by this stable id (the canvas node's id), not
  // by its board — so it starts empty and stays separate from sibling sections.
  const sectionId = node.id;
  const units = useSectionUnits(sectionId);

  const [mode, setMode] = useState<Mode>(boardId ? "committed" : "naming");
  const [rows, setRows] = useState<OutlineRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [focus, setFocus] = useState<{ key: string; caret: number } | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement | HTMLTextAreaElement>>(new Map());

  // Autosave plumbing. `rowsRef` gives async saves the latest rows; the content
  // signature (indent/desc/text, order — NOT taskId) decides when a save is
  // due, so writing freshly-created ids back onto rows never re-triggers a save.
  const rowsRef = useRef(rows);
  useEffect(() => void (rowsRef.current = rows), [rows]);
  // `save()` deletes tasks not present in `rows`, so it is ONLY valid while
  // authoring (when rows faithfully mirror the section). In committed mode rows
  // is [] and must never drive a save — otherwise a remount (React StrictMode,
  // navigation) would flush an empty outline and wipe every task.
  const modeRef = useRef(mode);
  useEffect(() => void (modeRef.current = mode), [mode]);
  const savedSigRef = useRef<string>("");
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentSig = (rs: OutlineRow[]) =>
    JSON.stringify(rs.map((r) => [r.indent, r.desc, r.text]));

  /* ---------------- content-driven height ---------------- */
  // Mirror the section card's rendered height into stored `node.height`, so the
  // card grows/shrinks to fit its outline or task cards instead of being a fixed
  // scroll box. Same pattern as the text CanvasNode: latest height/callback live
  // in refs so the observer is created once, and a round-guard avoids write loops
  // and jitter. Committing an outline can add/remove rows, so height tracks that.
  const boxRef = useRef<HTMLDivElement>(null);
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

  /* ---------------- authoring: enter / seed ---------------- */
  const enterAuthoring = useCallback(() => {
    const seeded = unitsToRows(units);
    const next = seeded.length ? seeded : [newRow(0)];
    savedSigRef.current = contentSig(next); // seeded state is already "saved"
    setRows(next);
    setMode("authoring");
    setFocus({ key: next[next.length - 1].key, caret: next[next.length - 1].text.length });
  }, [units]);

  // Reposition the caret only when `focus` changes (after a structural edit:
  // new row, merge, role cycle, arrow nav). Depending on `rows` here would
  // re-run on every keystroke and yank the caret back to the start — typing
  // the line in reverse. Each structural op sets a fresh `focus` object, so
  // this fires exactly when we want it to.
  useEffect(() => {
    if (!focus) return;
    const el = inputRefs.current.get(focus.key);
    if (el) {
      el.focus();
      const c = Math.min(focus.caret, el.value.length);
      el.setSelectionRange(c, c);
    }
  }, [focus]);

  /* ---------------- authoring: row edits ---------------- */
  const setText = (key: string, text: string) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, text } : r)));

  /** The deepest indent a task at `index` may take = (nearest task above)+1.
   *  -1 means there's no task above to nest under (the very first line). */
  const maxTaskIndent = (index: number) => {
    for (let i = index - 1; i >= 0; i--) if (!rows[i].desc) return rows[i].indent + 1;
    return -1;
  };

  const onRowKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    row: OutlineRow,
    index: number,
  ) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void flush();
      setMode("committed");
      return;
    }

    // ---- Description rows: a plain multiline block ----
    if (row.desc) {
      if (e.key === "Tab" && e.shiftKey) {
        // SHIFT+TAB inside a description: pop the CURRENT line out as a bullet
        // (a task at the description's own indent = a subtask of its owner),
        // leaving the lines above as the description; lines below follow it.
        e.preventDefault();
        const val = row.text;
        const caret = e.currentTarget.selectionStart ?? val.length;
        const lineStart = val.lastIndexOf("\n", caret - 1) + 1;
        const nl = val.indexOf("\n", caret);
        const lineEnd = nl === -1 ? val.length : nl;
        const before = val.slice(0, lineStart).replace(/\n$/, "");
        const currentLine = val.slice(lineStart, lineEnd);
        const after = val.slice(lineEnd).replace(/^\n/, "");

        const bullet = newRow(row.indent, false, currentLine);
        const inserts: OutlineRow[] = [bullet];
        if (after.trim()) inserts.push(newRow(row.indent + 1, true, after));
        setRows((rs) => {
          const copy = rs.slice();
          if (before.trim()) {
            copy[index] = { ...row, text: before };
            copy.splice(index + 1, 0, ...inserts);
          } else {
            copy.splice(index, 1, ...inserts); // desc had only this line → replace it
          }
          return copy;
        });
        setFocus({ key: bullet.key, caret: currentLine.length });
        return;
      }
      if (e.key === "Tab") e.preventDefault(); // forward Tab: no-op (deepest role)
      // Enter (newline), arrows, Backspace: all native inside the block.
      return;
    }

    // ---- Task rows ----
    if (e.key === "Tab") {
      e.preventDefault();
      const max = maxTaskIndent(index);
      if (max < 0) return; // first line — nothing above to nest under
      if (e.shiftKey) {
        // Outdent one level; at the left edge, nothing happens.
        if (row.indent > 0) {
          setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, indent: r.indent - 1 } : r)));
          setFocus({ key: row.key, caret: e.currentTarget.selectionStart ?? row.text.length });
        }
        return;
      }
      if (row.indent < max) {
        // Nest one level deeper (subtask / sub-subtask …).
        setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, indent: r.indent + 1 } : r)));
      } else {
        // Already as deep as allowed → this line becomes the task's description.
        setRows((rs) =>
          rs.map((r) => (r.key === row.key ? { ...r, desc: true, taskId: null } : r)),
        );
      }
      setFocus({ key: row.key, caret: e.currentTarget.selectionStart ?? row.text.length });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const caret = e.currentTarget.selectionStart ?? row.text.length;
      // Split at the caret → a new sibling task at the same indent. A bound task
      // keeps its id on the head (same task, renamed); the tail is a new task.
      const head = row.text.slice(0, caret);
      const tail = row.text.slice(caret);
      const created = newRow(row.indent, false, tail);
      setRows((rs) => {
        const copy = rs.slice();
        copy[index] = { ...row, text: head };
        copy.splice(index + 1, 0, created);
        return copy;
      });
      setFocus({ key: created.key, caret: 0 });
      return;
    }
    if (e.key === "Backspace" && (e.currentTarget.selectionStart ?? 0) === 0 && index > 0) {
      // Merge into the previous row (its id/role win); this row is dropped.
      e.preventDefault();
      const prev = rows[index - 1];
      const mergedCaret = prev.text.length;
      setRows((rs) => {
        const copy = rs.slice();
        copy[index - 1] = { ...prev, text: prev.text + row.text };
        copy.splice(index, 1);
        return copy;
      });
      setFocus({ key: prev.key, caret: mergedCaret });
      return;
    }
    if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      const prev = rows[index - 1];
      setFocus({ key: prev.key, caret: prev.text.length });
      return;
    }
    if (e.key === "ArrowDown" && index < rows.length - 1) {
      e.preventDefault();
      const nxt = rows[index + 1];
      setFocus({ key: nxt.key, caret: nxt.text.length });
    }
  };

  /* ---------------- commit: rows → tasks (up to 3 bulk batches) ------------- */
  const bulk = async (operations: unknown[]) => {
    const res = await fetch("/api/tasks/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations }),
    });
    if (!res.ok) throw new Error(`bulk failed (${res.status})`);
    return (await res.json()) as {
      results: { op: string; ok: boolean; id?: string }[];
    };
  };

  // Persist the current outline → tasks. Runs on a debounce while you type (and
  // on demand via flush). Guarded so saves never overlap; a save requested mid-
  // flight re-runs afterwards. Freshly-created task ids are written back onto the
  // rows so the NEXT save updates those tasks instead of duplicating them.
  const save = useCallback(async () => {
    // Guard: only persist while authoring — rows is the source of truth only
    // then. Never let an empty committed-mode rows delete the section's tasks.
    if (!boardId || modeRef.current !== "authoring") return;
    // Nothing changed since the last save — a bare view toggle, Esc, "done", or
    // unmount over an untouched outline. Bail before touching state or the
    // network (this is the same dirty-check the debounced autosave already has;
    // the direct callers were missing it and re-persisted every task for free).
    const current = rowsRef.current;
    const sig = contentSig(current);
    if (sig === savedSigRef.current) return;
    if (savingRef.current) {
      pendingRef.current = true;
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const built = rowsToUnits(current);
      // Section tasks are scoped by the sectionId tag, never the board — so
      // saving one section never touches another section's tasks.
      const sectionNodes = ws.nodes.filter(
        (n) => ws.taskMap[n.id]?.customFields?.sectionId === sectionId,
      );
      const surviving = survivingIds(built);
      const toDelete = sectionNodes.map((n) => n.id).filter((id) => !surviving.has(id));

      const tag = { sectionId };
      const flat = flattenUnits(built);
      const maxDepth = flat.reduce((m, n) => Math.max(m, n.depth), 0);

      // 1. CREATES only, level by level, so a parent always has its id before its
      // children are created (arbitrary nesting depth). Creating is the sole thing
      // that needs its own ordered batches — everything else collapses into §2.
      for (let d = 0; d <= maxDepth; d++) {
        const level = flat.filter((n) => n.depth === d && !n.unit.taskId);
        if (!level.length) continue;
        const ops = level.map((n) => ({
          op: "create",
          input: {
            title: n.unit.title,
            description: n.unit.description || undefined,
            boardId,
            parentId: n.parent?.taskId ?? undefined,
            customFields: tag,
          },
        }));
        const { results } = await bulk(ops);
        let k = 0;
        for (const r of results) if (r.op === "create" && r.ok && r.id) level[k++].unit.taskId = r.id;
      }

      // 2. ONE final batch carrying ONLY what actually changed: content updates,
      // reorders/reparents, and deletes. /api/tasks/bulk runs ops in array order,
      // so a lone request suffices (updates → moves → deletes). A plain text edit
      // that adds/removes/reorders nothing thus becomes a single one-op POST.
      const finalOps: unknown[] = [];

      // updates — skip tasks whose title AND description are unchanged. Tasks just
      // created above aren't in taskMap yet, so they fall through here (their
      // create already carried the right content).
      for (const n of flat) {
        const id = n.unit.taskId;
        if (!id) continue;
        const t = ws.taskMap[id];
        if (!t) continue;
        const nextDesc = n.unit.description || null;
        if (t.title !== n.unit.title || (t.description ?? null) !== nextDesc) {
          finalOps.push({ op: "update", id, patch: { title: n.unit.title, description: nextDesc } });
        }
      }

      // moves — only for sibling groups whose parent or order changed. Positions
      // are sparse/fractional, so compare id-sequences, not raw positions; when a
      // group did change, reassert dense positions (0,1,2,…) for all its members.
      const currentParent = new Map(sectionNodes.map((n) => [n.id, n.parentId]));
      const currentOrder = [...sectionNodes]
        .sort((a, b) => a.position - b.position)
        .map((n) => n.id);
      const desiredByParent = new Map<string | null, string[]>();
      for (const n of flat) {
        if (!n.unit.taskId) continue;
        const p = n.parent?.taskId ?? null;
        const arr = desiredByParent.get(p);
        if (arr) arr.push(n.unit.taskId);
        else desiredByParent.set(p, [n.unit.taskId]);
      }
      for (const [parentId, desiredIds] of desiredByParent) {
        const desiredSet = new Set(desiredIds);
        // Existing tasks are those already in the DB (freshly-created ids aren't
        // in currentParent). A group is dirty if any moved parent, any is new, or
        // the existing tasks' order differs from the DB's.
        const existingDesired = desiredIds.filter((id) => currentParent.has(id));
        const currentSeq = currentOrder.filter((id) => desiredSet.has(id));
        const parentChanged = existingDesired.some((id) => currentParent.get(id) !== parentId);
        const hasNew = desiredIds.length !== existingDesired.length;
        const orderChanged = existingDesired.join(" ") !== currentSeq.join(" ");
        if (!parentChanged && !hasNew && !orderChanged) continue;
        desiredIds.forEach((id, i) =>
          finalOps.push({ op: "move", id, target: { parentId, position: i } }),
        );
      }

      toDelete.forEach((id) => finalOps.push({ op: "delete", id }));
      if (finalOps.length) await bulk(finalOps);

      // Write freshly-created ids back onto the editor rows (matched by rowKey).
      // Only touches taskId, so the content signature is unchanged → no re-save.
      const idByRow = new Map<string, string>();
      for (const n of flat) if (n.unit.rowKey && n.unit.taskId) idByRow.set(n.unit.rowKey, n.unit.taskId);
      setRows((rs) =>
        rs.map((r) => {
          const id = idByRow.get(r.key);
          return id && r.taskId !== id ? { ...r, taskId: id } : r;
        }),
      );
      savedSigRef.current = sig;
      await ws.refresh();
    } catch (err) {
      console.error("[section] save failed", err);
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (pendingRef.current) {
        pendingRef.current = false;
        void save();
      }
    }
  }, [boardId, sectionId, ws]);

  /** Save now, cancelling any pending debounce (used on toggle / Esc / unmount). */
  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    return save();
  }, [save]);

  // Debounced autosave: whenever the outline's content changes while authoring,
  // save ~700ms later. Writing ids back doesn't change the signature, so it
  // never loops. Flush on leaving authoring / unmount so nothing is lost.
  useEffect(() => {
    if (mode !== "authoring" || !boardId) return;
    if (contentSig(rows) === savedSigRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [rows, mode, boardId, save]);

  useEffect(() => {
    return () => {
      // Only flush a genuine in-progress authoring session — never a committed
      // section (rows is [] there, which would delete everything on remount).
      if (modeRef.current === "authoring" && savedSigRef.current !== contentSig(rowsRef.current)) {
        void save();
      }
    };
    // Save-on-unmount only; `save` is stable enough and we don't want to re-arm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- binding (naming) ---------------- */
  const bindBoard = (id: string, name: string) => {
    onPatch({ content: name, data: { ...(node.data ?? {}), boardId: id } });
    setMode("committed");
    // Jump straight into authoring so you can start typing tasks.
    requestAnimationFrame(() => {
      const seed = [newRow(0)];
      savedSigRef.current = contentSig(seed);
      setRows(seed);
      setMode("authoring");
      setFocus(null);
    });
  };

  /* ---------------- send everything to the master section ------------- */
  // Re-group this section's cards onto its board's master section (placed on
  // top), then remove this now-empty section from the canvas. Source and master
  // share a board, so this only re-tags `customFields.sectionId` and reorders —
  // no board move.
  const sendToMaster = useCallback(async () => {
    if (!boardId || !masterSection) return;

    // Every task in this section (all depths), read from the workspace so it's
    // independent of the current view mode.
    const sectionTaskIds = ws.nodes
      .filter((n) => ws.taskMap[n.id]?.customFields?.sectionId === sectionId)
      .map((n) => n.id);

    const n = sectionTaskIds.length;
    if (
      !confirm(
        n
          ? `Send ${n} card${n === 1 ? "" : "s"} to the top of “${masterSection.name}” and delete this section?`
          : `Delete this empty section?`,
      )
    )
      return;

    setSaving(true);
    try {
      if (n) {
        const topLevel = (secId: string) =>
          ws.nodes
            .filter(
              (nd) =>
                nd.parentId === null &&
                ws.taskMap[nd.id]?.customFields?.sectionId === secId,
            )
            .sort((a, b) => a.position - b.position)
            .map((nd) => nd.id);
        const sourceTop = topLevel(sectionId);
        const masterTop = topLevel(masterSection.id);

        const ops: unknown[] = [];
        // Re-tag every source task into the master section. updateTask REPLACES
        // customFields, so resend the full object (preserving other fields).
        for (const id of sectionTaskIds) {
          const cf = ws.taskMap[id]?.customFields ?? {};
          ops.push({
            op: "update",
            id,
            patch: { customFields: { ...cf, sectionId: masterSection.id } },
          });
        }
        // Reassert dense top-level order: source cards first (= on top), then
        // the master's existing cards. Nested tasks keep their parent/order.
        [...sourceTop, ...masterTop].forEach((id, i) =>
          ops.push({ op: "move", id, target: { position: i } }),
        );

        await bulk(ops);
        await ws.refresh();
      }
      onRemove?.();
    } catch (err) {
      console.error("[section] send-to-master failed", err);
    } finally {
      setSaving(false);
    }
  }, [boardId, masterSection, sectionId, ws, onRemove]);

  /* =================================================================== */
  /* Render                                                              */
  /* =================================================================== */

  const title = node.content.trim();

  return (
    <div
      ref={boxRef}
      // Content-driven height: the card sizes to its outline/task cards (grows and
      // shrinks), and `onResize` mirrors that into stored `node.height`. `minHeight`
      // (not `node.height`) is the floor, which is what lets it shrink back down.
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.width,
        height: "auto",
        minHeight: MIN_SECTION_HEIGHT,
      }}
      className={[
        "group/section flex flex-col overflow-hidden rounded-xl border-2 bg-surface shadow-sm",
        selected ? "border-accent" : "border-border-strong",
      ].join(" ")}
    >
      {/* Header = title chip + drag handle + edit affordance */}
      <div
        onPointerDown={onPointerDown}
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 active:cursor-grabbing"
      >
        <span aria-hidden className="text-faint">▤</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          {title || "Untitled section"}
        </span>
        {saving ? (
          <span
            aria-label="Saving"
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-faint border-t-transparent"
          />
        ) : null}
        {/* Send-to-master: shown on non-master sections that have a master on
            the same board. Hover-revealed, like the canvas-index card's ✕. */}
        {boardId && !isMaster && masterSection ? (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              void sendToMaster();
            }}
            title={`Send all cards to the top of “${masterSection.name}” and delete this section`}
            className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-faint opacity-0 transition-colors hover:border-accent hover:text-accent group-hover/section:opacity-100"
          >
            ↥ Send to {masterSection.name}
          </button>
        ) : null}
        {boardId ? (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
          >
            <ViewToggleBtn
              active={isMaster}
              onClick={() => onSetMaster?.(!isMaster)}
              title={isMaster ? "Master section (click to unset)" : "Make this the board's master section"}
            >
              {isMaster ? "★" : "☆"}
            </ViewToggleBtn>
            <ViewToggleBtn
              active={mode === "authoring"}
              onClick={() => mode !== "authoring" && enterAuthoring()}
              title="Outline"
            >
              ≣
            </ViewToggleBtn>
            <ViewToggleBtn
              active={mode === "committed"}
              onClick={() => {
                if (mode === "committed") return;
                void flush();
                setMode("committed");
              }}
              title="Cards"
            >
              ▦
            </ViewToggleBtn>
          </div>
        ) : null}
      </div>

      {/* Body — interior stops canvas panning/selection so it stays interactive
          (pointer for pan/marquee). Grows with its content (no internal scroll):
          the whole card follows via the ResizeObserver above. `flex-1`/`min-h-0`
          let the body fill the card down to MIN_SECTION_HEIGHT when content is
          short, so the empty-state `h-full` still centers. */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="min-h-0 flex-1 overflow-hidden p-2"
      >
        {mode === "naming" ? (
          <NameBinder onBind={bindBoard} />
        ) : mode === "authoring" ? (
          <OutlineEditor
            rows={rows}
            inputRefs={inputRefs}
            onText={setText}
            onKeyDown={onRowKeyDown}
            onDone={() => {
              void flush();
              setMode("committed");
            }}
          />
        ) : (
          <CommittedList
            units={units}
            taskMap={ws.taskMap}
            onOpen={ws.openTask}
            onToggle={ws.toggleDone}
            onStatus={ws.setStatus}
            onAssign={ws.editTask}
            onMove={ws.moveNode}
            onAdd={enterAuthoring}
          />
        )}
      </div>
    </div>
  );
}

/** Segmented view-switch button in the section header (Outline ⇄ Cards). */
function ViewToggleBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={[
        "grid h-5 w-5 place-items-center rounded text-xs transition-colors",
        active ? "bg-accent-soft text-accent" : "text-faint hover:text-fg",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/* ---------------- naming ---------------- */

function NameBinder({
  onBind,
}: {
  onBind: (boardId: string, name: string) => void;
}) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");

  // Pick an EXISTING board — the section attaches to it (that's where its tasks
  // live and how they show up in the board view). It does NOT pull in the
  // board's current tasks: a section only shows the tasks you add to it, scoped
  // by its own hidden section id. Several sections can point at one board.
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = ws.projects.flatMap((p) =>
      (p.boards ?? []).map((b) => ({ id: b.id, name: b.name, project: p.name })),
    );
    if (!needle) return all.slice(0, 8);
    return all.filter((b) => b.name.toLowerCase().includes(needle)).slice(0, 8);
  }, [q, ws.projects]);

  return (
    <div className="space-y-2">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches.length) {
            e.preventDefault();
            onBind(matches[0].id, matches[0].name);
          }
        }}
        placeholder="Which board is this section on?"
        className="w-full rounded-md border border-accent bg-surface px-2 py-1 text-sm text-fg outline-none"
      />
      <div className="overflow-hidden rounded-md border border-border">
        {matches.length === 0 ? (
          <p className="px-2 py-2 text-xs text-faint">
            No boards match. Create the board first, then attach a section to it.
          </p>
        ) : (
          matches.map((b) => (
            <button
              key={b.id}
              onClick={() => onBind(b.id, b.name)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-surface-2"
            >
              <span className="truncate text-fg">{b.name}</span>
              <span className="ml-auto shrink-0 truncate text-[11px] text-faint">{b.project}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------- authoring ---------------- */

function OutlineEditor({
  rows,
  inputRefs,
  onText,
  onKeyDown,
  onDone,
}: {
  rows: OutlineRow[];
  inputRefs: React.MutableRefObject<Map<string, HTMLInputElement | HTMLTextAreaElement>>;
  onText: (key: string, text: string) => void;
  onKeyDown: (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    row: OutlineRow,
    index: number,
  ) => void;
  onDone: () => void;
}) {
  return (
    <div className="space-y-0.5">
      {rows.map((row, i) => {
        const pad = row.indent * 16;
        const setRef = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
          if (el) inputRefs.current.set(row.key, el);
          else inputRefs.current.delete(row.key);
        };
        return (
          <div key={row.key} className="flex items-start gap-1.5" style={{ paddingLeft: pad }}>
            {row.desc ? null : (
              <span className="mt-0.5 shrink-0 select-none text-xs text-muted">–</span>
            )}
            {row.desc ? (
              // A description is a plain multiline block — italic, no label.
              // Enter = newline, Shift+Tab pops a line out (see onRowKeyDown).
              <textarea
                ref={setRef}
                value={row.text}
                rows={Math.max(1, row.text.split("\n").length)}
                onChange={(e) => onText(row.key, e.target.value)}
                onKeyDown={(e) => onKeyDown(e, row, i)}
                className="w-full resize-none bg-transparent text-sm italic leading-snug text-muted outline-none"
                placeholder="description…"
              />
            ) : (
              <input
                ref={setRef}
                value={row.text}
                onChange={(e) => onText(row.key, e.target.value)}
                onKeyDown={(e) => onKeyDown(e, row, i)}
                className="w-full bg-transparent text-sm text-fg outline-none"
                placeholder="task…"
              />
            )}
          </div>
        );
      })}
      <div className="pt-2 text-[11px] text-faint">
        Tab: nest deeper → description · Shift+Tab: back out · autosaves ·{" "}
        <button onClick={onDone} className="underline hover:text-accent">
          done
        </button>
      </div>
    </div>
  );
}

/* ---------------- committed ---------------- */

interface CardHandlers {
  taskMap: Record<string, Task>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onStatus: (id: string, s: TaskStatus) => void;
  onAssign: (id: string, patch: { assigneeIds: string[] }) => void;
  onMove: (dragId: string, targetId: string, pos: DropPos) => void;
  dropHint: { id: string; pos: "before" | "after" } | null;
  setDropHint: (h: { id: string; pos: "before" | "after" } | null) => void;
}

/** One task card + its children, rendered recursively (arbitrary depth). */
function TaskCard({ unit, depth, h }: { unit: TaskUnit; depth: number; h: CardHandlers }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const id = unit.taskId;
  const t = id ? h.taskMap[id] : undefined;
  const done = t?.status === "done";
  // "D" on the hovered card toggles done: not-done → done (via the checkbox's
  // old /complete path), done → in-progress (setStatus clears completedAt).
  useCardShortcut(cardRef, "d", () => {
    if (!id) return;
    if (done) h.onStatus(id, "in-progress");
    else h.onToggle(id);
  });
  if (!id || !t) return null;
  const hint = h.dropHint?.id === id ? h.dropHint.pos : null;
  const half = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };
  return (
    <div style={{ marginLeft: depth ? 12 : 0 }}>
      <div
        ref={cardRef}
        data-card
        data-task-id={id}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(SECTION_DND_MIME, id);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(SECTION_DND_MIME)) return;
          e.preventDefault();
          h.setDropHint({ id, pos: half(e) });
        }}
        onDragLeave={() => h.dropHint?.id === id && h.setDropHint(null)}
        onDrop={(e) => {
          const dragId = e.dataTransfer.getData(SECTION_DND_MIME);
          const pos = half(e);
          h.setDropHint(null);
          if (dragId && dragId !== id) h.onMove(dragId, id, pos);
        }}
        className={[
          "group/card rounded-lg border border-border bg-surface px-2 py-1.5",
          hint === "before" ? "shadow-[inset_0_2px_0_0_var(--color-accent)]" : "",
          hint === "after" ? "shadow-[inset_0_-2px_0_0_var(--color-accent)]" : "",
        ].join(" ")}
      >
        <div className="min-w-0 flex-1">
          <button
            onClick={() => h.onOpen(id)}
            className={[
              "block w-full truncate text-left text-sm",
              done ? "text-faint line-through" : "text-fg",
            ].join(" ")}
          >
            {t.title}
          </button>
          {t.description ? (
            <div className="mt-0.5 line-clamp-2 text-xs italic text-muted">
              <Markdown>{t.description}</Markdown>
            </div>
          ) : null}
          <div className="mt-1 flex items-center gap-2">
            {t.assigneeIds?.length ? <AvatarStack ids={t.assigneeIds} size={18} /> : null}
            {/* Hover-only controls: status (S) + assign (A). Done is toggled with D. */}
            <div className="ml-auto flex items-center gap-1">
              <QuickStatus status={t.status} onChange={(s) => h.onStatus(id, s)} />
              <QuickAssign taskId={id} assigneeIds={t.assigneeIds ?? []} onChange={h.onAssign} />
            </div>
          </div>
        </div>
      </div>
      {unit.children.length ? (
        <div className="mt-1.5 space-y-1.5">
          {unit.children.map((c) => (
            <TaskCard key={c.taskId ?? c.title} unit={c} depth={depth + 1} h={h} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CommittedList({
  units,
  taskMap,
  onOpen,
  onToggle,
  onStatus,
  onAssign,
  onMove,
  onAdd,
}: {
  units: TaskUnit[];
  taskMap: Record<string, Task>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onStatus: (id: string, s: TaskStatus) => void;
  onAssign: (id: string, patch: { assigneeIds: string[] }) => void;
  onMove: (dragId: string, targetId: string, pos: DropPos) => void;
  onAdd: () => void;
}) {
  const [dropHint, setDropHint] = useState<{ id: string; pos: "before" | "after" } | null>(null);

  if (!units.length) {
    return (
      <button
        onClick={onAdd}
        className="grid h-full w-full place-items-center text-sm text-faint hover:text-accent"
      >
        No tasks yet — click to add.
      </button>
    );
  }

  const h: CardHandlers = { taskMap, onOpen, onToggle, onStatus, onAssign, onMove, dropHint, setDropHint };
  return (
    <div className="space-y-1.5">
      {units.map((u) => (
        <TaskCard key={u.taskId ?? u.title} unit={u} depth={0} h={h} />
      ))}
      <button
        onClick={onAdd}
        className="w-full rounded-md border border-dashed border-border px-2 py-1 text-left text-xs text-faint hover:border-accent hover:text-accent"
      >
        ＋ Add / edit outline
      </button>
    </div>
  );
}
