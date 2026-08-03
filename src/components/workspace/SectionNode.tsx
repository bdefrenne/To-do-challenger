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
 *
 * A section can also carry a name of its OWN (`data.name`, set by double-clicking
 * the header title). When set it takes the title slot and the bound board's name
 * (`node.content`) trails it inline, dimmed and regular weight.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useMyPresence, useOthers, useSelf } from "@liveblocks/react";
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
import type { TaskStatus, Importance } from "@/lib/types";
import { useWorkspace, type DropPos } from "./WorkspaceContext";
import { useSectionMembership } from "./SectionMembershipContext";
import { isInboxNode } from "@/lib/sections";
import { TaskCardBody } from "./TaskCardBody";
import { useCardShortcut } from "./useCardShortcut";
import { IMPORTANCE_CARD } from "@/lib/importance";
import { STATUS_TONE, STATUS_CANVAS_BADGE } from "@/lib/statuses";

export const NEW_SECTION_SIZE = { width: 420, height: 320 };

/** Floor height for a section card so an empty/naming one isn't a sliver. Above
 *  this the card grows to fit its outline/tasks (`height: auto`), and the height
 *  is mirrored back into stored `node.height`. */
export const MIN_SECTION_HEIGHT = 140;

const SECTION_DND_MIME = "application/x-section-task";

type Mode = "naming" | "authoring" | "committed";

/** The task TREE for ONE section, read from the live workspace. Which tasks
 *  belong here is resolved for the whole canvas at once (see
 *  `buildSectionMembership`): a task pinned to this node, or — if this node is
 *  an INBOX lane — any unpinned task on its board. Arbitrary nesting depth. */
function useSectionUnits(sectionId: string): TaskUnit[] {
  const { nodes, taskMap } = useWorkspace();
  const { bySection } = useSectionMembership();
  return useMemo(() => {
    const members = bySection.get(sectionId);
    if (!members) return [];
    const childrenOf = (parentId: string) =>
      nodes.filter((n) => n.parentId === parentId && members.has(n.id));
    // Roots of THIS section: top-level tasks, plus any whose parent isn't here
    // too — a subtask whose parent was dragged into another section would
    // otherwise have no row to hang off and would vanish.
    const roots = nodes.filter(
      (n) => members.has(n.id) && (n.parentId === null || !members.has(n.parentId)),
    );
    const build = (rows: typeof nodes): TaskUnit[] =>
      [...rows]
        .sort((a, b) => a.position - b.position)
        .map((n) => {
          const t = taskMap[n.id];
          return {
            taskId: n.id,
            title: t?.title ?? "",
            description: t?.description ?? "",
            children: build(childrenOf(n.id)),
          };
        });
    return build(roots);
  }, [sectionId, nodes, taskMap, bySection]);
}

export function SectionNode({
  node,
  selected,
  smooth = true,
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
  /** Ease position changes (remote moves). Off while YOU drag it, so your own
   *  drag stays glued to the cursor with no rubber-banding. */
  smooth?: boolean;
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
  // Who created this section. The board-picker (naming mode) is private to the
  // creator — peers see a placeholder until a board is bound. Legacy sections
  // with no `createdBy` stay bindable by anyone (the `!createdBy` fallback).
  const createdBy = node.data?.createdBy as string | undefined;
  const myId = useSelf((me) => me.id);
  const isCreator = !createdBy || createdBy === myId;
  // A section's tasks are scoped by this stable id (the canvas node's id), not
  // by its board — so it starts empty and stays separate from sibling sections.
  const sectionId = node.id;
  const units = useSectionUnits(sectionId);
  // An INBOX lane: a tray showing its board's UNPINNED tasks, so that anything
  // created from the API, MCP or a board view is visible here instead of nowhere.
  // Cards land in it by having no pin, which is why `pin` is null for a lane —
  // pinning to it would immediately take the card out of it again.
  const isInbox = isInboxNode(node);
  const pin = isInbox ? null : sectionId;
  const { bySection } = useSectionMembership();
  const siblingIds = useMemo(
    () => bySection.get(sectionId) ?? new Set<string>(),
    [bySection, sectionId],
  );

  // Soft field-lock (presence): while a user authors this section's outline they
  // publish `editing`, and peers show a lock + can't open the outline — so two
  // people don't batch-save the same section over each other. Presence is
  // ephemeral, so the lock auto-releases if their tab closes.
  const [, updateMyPresence] = useMyPresence();
  const others = useOthers();
  const editingPeer = others.find((o) => o.presence.editing?.taskId === sectionId);
  const remoteEditor = editingPeer
    ? { name: editingPeer.info?.name ?? "Someone", color: editingPeer.info?.color ?? "#888" }
    : null;
  const locked = remoteEditor !== null;

  // Task ids this authoring session is allowed to delete = the section's tasks
  // when authoring began, plus any it creates. Guards against deleting a task a
  // PEER adds to this section while we're editing a stale local outline.
  const knownIdsRef = useRef<Set<string>>(new Set());

  // An INBOX lane never goes through naming: its board is fixed by the
  // reconciler, and the "No board" lane is legitimately board-less.
  const [mode, setMode] = useState<Mode>(boardId || isInbox ? "committed" : "naming");
  // `mode` is seeded from `boardId` only once, so a peer sitting in naming (the
  // placeholder) when the author picks a board would stay stuck on the pre-bind
  // view. Derive the DISPLAYED mode from the live `boardId` instead of mutating
  // state in an effect: once bound, everyone renders committed. The state
  // machine (authoring transitions, saves) still keys off the real `mode`.
  const viewMode: Mode = (boardId || isInbox) && mode === "naming" ? "committed" : mode;
  // Text-mode display preference (session-only): descriptions grow up to 6 rows
  // by default; toggled to unbounded via the header button. Not persisted.
  const [descExpanded, setDescExpanded] = useState(false);
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
    // Baseline of deletable ids = the tasks this section has right now.
    knownIdsRef.current = new Set(
      flattenUnits(units)
        .map((f) => f.unit.taskId)
        .filter((id): id is string => !!id),
    );
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
      // Scoped to the tasks THIS section renders (resolved canvas-wide), never
      // the board — so saving one section never touches another's tasks.
      const sectionNodes = ws.nodes.filter((n) => siblingIds.has(n.id));
      const surviving = survivingIds(built);
      // Only delete tasks THIS session knows about (baseline + ones it created).
      // A task a peer added to this section meanwhile isn't in knownIds, so our
      // stale outline can never delete it.
      const toDelete = sectionNodes
        .map((n) => n.id)
        .filter((id) => knownIdsRef.current.has(id) && !surviving.has(id));

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
            // Only roots carry the pin — nested lines inherit their parent's
            // placement. Null in an INBOX lane, where unpinned IS the membership.
            ...(n.parent ? {} : { canvasSectionId: pin }),
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
      // Tasks we just created become deletable in later saves of this session.
      flat.forEach((n) => n.unit.taskId && knownIdsRef.current.add(n.unit.taskId));
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
  }, [boardId, ws, pin, siblingIds]);

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

  // Publish a soft outline-lock while authoring this section, so peers see it's
  // being edited and are blocked from opening it. Cleared on leave/unmount
  // (Liveblocks also drops it automatically if this tab disconnects).
  useEffect(() => {
    if (mode !== "authoring") return;
    updateMyPresence({ editing: { taskId: sectionId, field: "outline" } });
    return () => updateMyPresence({ editing: null });
  }, [mode, sectionId, updateMyPresence]);

  // Live re-sync (realtime): while authoring, pull in peers' task edits — but
  // ONLY when our outline has no unsaved changes AND we aren't focused in it, so
  // we never clobber in-flight typing or steal the caret. This is why text mode
  // now reflects other users' updates instead of showing a frozen snapshot.
  useEffect(() => {
    if (mode !== "authoring") return;
    if (contentSig(rowsRef.current) !== savedSigRef.current) return; // dirty
    const active = document.activeElement;
    const focusedHere = [...inputRefs.current.values()].some((el) => el === active);
    if (focusedHere) return;
    const seeded = unitsToRows(units);
    const next = seeded.length ? seeded : [newRow(0)];
    const nextSig = contentSig(next);
    if (nextSig === savedSigRef.current) return; // nothing new upstream
    savedSigRef.current = nextSig; // adopt as the new clean baseline (no re-save)
    knownIdsRef.current = new Set(
      flattenUnits(units)
        .map((f) => f.unit.taskId)
        .filter((id): id is string => !!id),
    );
    setRows(next);
  }, [units, mode]);

  /* ---------------- the section's own name ---------------- */
  // `data.name` is optional and lives alongside the bound board (`node.content`
  // stays the BOARD's name). Double-clicking the header title opens this inline
  // field; committing happens on blur only (Enter/Escape just blur), with
  // `cancelRenameRef` marking an Escape so it discards instead of saving.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const cancelRenameRef = useRef(false);

  const startRename = () => {
    cancelRenameRef.current = false;
    setNameDraft(((node.data?.name as string | undefined) ?? "").trim());
    setRenaming(true);
  };

  const commitName = (raw: string) => {
    setRenaming(false);
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    const next = raw.trim();
    const current = ((node.data?.name as string | undefined) ?? "").trim();
    if (next === current) return;
    const data = { ...(node.data ?? {}) };
    // Clearing the field drops the key entirely, so the header falls back to
    // showing just the board name (as it did before a name was ever set).
    if (next) data.name = next;
    else delete data.name;
    onPatch({ data });
  };

  /* ---------------- binding (naming) ---------------- */
  const bindBoard = (id: string, name: string) => {
    onPatch({ content: name, data: { ...(node.data ?? {}), boardId: id } });
    setMode("committed");
    // Jump straight into authoring so you can start typing tasks.
    requestAnimationFrame(() => {
      const seed = [newRow(0)];
      savedSigRef.current = contentSig(seed);
      knownIdsRef.current = new Set(); // brand-new section: nothing to delete
      setRows(seed);
      setMode("authoring");
      setFocus(null);
    });
  };

  /* ---------------- send everything to the master section ------------- */
  // Re-group this section's cards onto its board's master section (placed on
  // top), then remove this now-empty section from the canvas. Source and master
  // share a board, so this only re-pins and reorders — no board move.
  const sendToMaster = useCallback(async () => {
    if (!boardId || !masterSection) return;

    // Every task in this section (all depths), read from the resolved membership
    // so it's independent of the current view mode.
    const sectionTaskIds = ws.nodes.filter((n) => siblingIds.has(n.id)).map((n) => n.id);

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
        const topLevel = (members: Set<string>) =>
          ws.nodes
            .filter((nd) => nd.parentId === null && members.has(nd.id))
            .sort((a, b) => a.position - b.position)
            .map((nd) => nd.id);
        const sourceTop = topLevel(siblingIds);
        const masterTop = topLevel(bySection.get(masterSection.id) ?? new Set());

        const ops: unknown[] = [];
        // Re-pin every top-level source card onto the master section; nested ones
        // inherit their parent's placement, so they need no write of their own.
        for (const id of sourceTop)
          ops.push({ op: "update", id, patch: { canvasSectionId: masterSection.id } });
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
  }, [boardId, masterSection, ws, onRemove, siblingIds, bySection]);

  /* =================================================================== */
  /* Render                                                              */
  /* =================================================================== */

  // Header title. `node.content` is the BOARD's name (set when the section was
  // bound); `data.name` is the section's OWN name, optional. With a name set it
  // takes the title slot and the board name trails it inline, dimmed and regular
  // weight — so the header reads "what this section is · which board it's on".
  const boardName = node.content.trim();
  const sectionName = ((node.data?.name as string | undefined) ?? "").trim();

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
        // Glide to new positions when the move came from someone else.
        transition: smooth ? "left 90ms linear, top 90ms linear" : undefined,
        // A peer editing this section's outline gets a ring in their color.
        outline: remoteEditor ? `2px solid ${remoteEditor.color}` : undefined,
        outlineOffset: 2,
      }}
      className={[
        "group/section flex flex-col overflow-hidden rounded-xl border-2 shadow-sm",
        // An INBOX lane reads as a tray, not a workspace: dashed edge and a muted
        // fill, so untriaged cards are visibly not "placed" anywhere yet.
        isInbox ? "border-dashed bg-surface-2/70" : "bg-surface",
        selected ? "border-accent" : isInbox ? "border-border" : "border-border-strong",
      ].join(" ")}
    >
      {/* Header = title chip + drag handle + edit affordance */}
      <div
        onPointerDown={onPointerDown}
        className="flex shrink-0 cursor-grab items-start gap-2 border-b border-border bg-surface-2 px-3 py-2 active:cursor-grabbing"
      >
        <span aria-hidden className="text-faint" title={isInbox ? "Inbox — unplaced tasks" : undefined}>
          {isInbox ? "⇥" : "▤"}
        </span>
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onFocus={(e) => e.currentTarget.select()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              // Keep section shortcuts / canvas keys out of the field. Enter and
              // Escape both leave via blur — commit lives in onBlur alone, so it
              // can never run twice for one edit.
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRenameRef.current = true;
                e.currentTarget.blur();
              }
            }}
            onBlur={() => commitName(nameDraft)}
            placeholder="Section name…"
            className="min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 py-0.5 text-sm font-semibold text-fg outline-none placeholder:font-normal placeholder:text-faint"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
            title={
              sectionName
                ? `${sectionName} — on board “${boardName}”. Double-click to rename.`
                : "Double-click to give this section its own name"
            }
            className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
          >
            <span className="min-w-0 break-words text-sm font-semibold text-fg">
              {sectionName || boardName || "Untitled section"}
            </span>
            {sectionName && boardName ? (
              <span className="min-w-0 truncate text-sm font-normal text-fg opacity-[0.84]">
                {boardName}
              </span>
            ) : null}
          </span>
        )}
        {saving ? (
          <span
            aria-label="Saving"
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-faint border-t-transparent"
          />
        ) : null}
        {remoteEditor ? (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
            style={{ backgroundColor: remoteEditor.color }}
            title={`${remoteEditor.name} is editing this section`}
          >
            ✎ {remoteEditor.name}
          </span>
        ) : null}
        {/* Send-to-master: shown on non-master sections that have a master on
            the same board. Hover-revealed, like the canvas-index card's ✕. */}
        {boardId && !isInbox && !isMaster && masterSection ? (
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
        {/* Description height: text-mode-only. Caps descriptions at 6 rows or
            lets them grow unbounded (session-only preference). */}
        {boardId && mode === "authoring" ? (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setDescExpanded((v) => !v);
            }}
            title={
              descExpanded
                ? "Descriptions: showing all — click to cap at 6 rows"
                : "Descriptions: capped at 6 rows — click to show all"
            }
            className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-faint hover:border-accent hover:text-accent"
          >
            {descExpanded ? "↕ All" : "↕ 6"}
          </button>
        ) : null}
        {boardId || isInbox ? (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
          >
            {/* An INBOX lane can't be a master: it's a tray tasks pass THROUGH,
                never a destination siblings should send their cards to. */}
            {isInbox ? null : (
              <ViewToggleBtn
                active={isMaster}
                onClick={() => onSetMaster?.(!isMaster)}
                title={isMaster ? "Master section (click to unset)" : "Make this the board's master section"}
              >
                {isMaster ? "★" : "☆"}
              </ViewToggleBtn>
            )}
            <ViewToggleBtn
              active={mode === "authoring"}
              disabled={locked}
              onClick={() => mode !== "authoring" && !locked && enterAuthoring()}
              title={locked ? `${remoteEditor?.name} is editing this section` : "Outline"}
            >
              ≣
            </ViewToggleBtn>
            <ViewToggleBtn
              active={viewMode === "committed"}
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
        {viewMode === "naming" ? (
          isCreator ? (
            <NameBinder onBind={bindBoard} />
          ) : (
            <PendingSetup
              who={others.find((o) => o.id === createdBy)?.info?.name ?? "Someone"}
            />
          )
        ) : viewMode === "authoring" ? (
          <OutlineEditor
            rows={rows}
            inputRefs={inputRefs}
            descCapped={!descExpanded}
            onText={setText}
            onKeyDown={onRowKeyDown}
          />
        ) : (
          <CommittedList
            units={units}
            taskMap={ws.taskMap}
            onOpen={ws.openTask}
            onToggle={ws.toggleDone}
            onStatus={ws.setStatus}
            onAssign={ws.editTask}
            onImportance={(id, v) => ws.editTask(id, { importance: v })}
            onMove={ws.moveNode}
            onAssignSelf={ws.toggleSelfAssignee}
            onDelete={ws.deleteTask}
            onAddTask={(title) =>
              ws.addSectionTask({ title, canvasSectionId: pin, boardId, parentId: null, siblingIds })
            }
            // Subtasks are never pinned — they inherit their parent's placement,
            // so they follow it if the parent is dragged elsewhere.
            onAddSubtask={(parentId, title) =>
              ws.addSectionTask({ title, canvasSectionId: null, boardId, parentId })
            }
            onDropIntoSection={(dragId) =>
              ws.moveNodeIntoSection(dragId, pin, boardId, { siblingIds })
            }
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
  disabled = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      disabled={disabled}
      title={title}
      className={[
        "grid h-5 w-5 place-items-center rounded text-xs transition-colors",
        active ? "bg-accent-soft text-accent" : "text-faint hover:text-fg",
        disabled ? "cursor-not-allowed opacity-40" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/* ---------------- naming ---------------- */

/** What peers see while the section's creator is still choosing its board. The
 *  board-picker is private to the creator; this flips to the committed section
 *  automatically once the creator binds a board (see the boardId effect). */
function PendingSetup({ who }: { who: string }) {
  return (
    <div className="flex h-full items-center justify-center px-3 text-center text-xs text-faint">
      {who} is setting up this section…
    </div>
  );
}

function NameBinder({
  onBind,
}: {
  onBind: (boardId: string, name: string) => void;
}) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Keep the highlighted row scrolled into view during arrow navigation.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="space-y-2">
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0); // filtering reflows the list — re-highlight the top
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length - 1));
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            const b = matches[active];
            if (b) onBind(b.id, b.name);
          }
        }}
        placeholder="Which board is this section on?"
        className="w-full rounded-md border border-accent bg-surface px-2 py-1 text-sm text-fg outline-none"
      />
      <div
        ref={listRef}
        className="max-h-48 overflow-y-auto rounded-md border border-border"
      >
        {matches.length === 0 ? (
          <p className="px-2 py-2 text-xs text-faint">
            No boards match. Create the board first, then attach a section to it.
          </p>
        ) : (
          matches.map((b, i) => (
            <button
              key={b.id}
              data-idx={i}
              onMouseEnter={() => setActive(i)}
              onClick={() => onBind(b.id, b.name)}
              className={[
                "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm",
                i === active ? "bg-surface-2" : "",
              ].join(" ")}
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

/** A textarea that auto-sizes to its content. When `capped`, it grows to at
 *  most 6 rows and scrolls the overflow; otherwise it grows unbounded. Used for
 *  both title rows (never capped — they just wrap) and description rows. Its
 *  inner textarea is forwarded to `registerRef` so the outline's inputRefs map
 *  and caret-restore effect keep working. */
function AutoGrowTextarea({
  value,
  capped,
  registerRef,
  onChange,
  onKeyDown,
  placeholder,
  className,
}: {
  value: string;
  capped: boolean;
  registerRef: (el: HTMLTextAreaElement | null) => void;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  className: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const MAX_ROWS = 6;
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    if (capped) {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const max = lh * MAX_ROWS;
      el.style.maxHeight = `${max}px`;
      el.style.height = `${Math.min(el.scrollHeight, max)}px`;
      el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    } else {
      el.style.maxHeight = "none";
      el.style.height = `${el.scrollHeight}px`;
      el.style.overflowY = "hidden";
    }
  }, [capped]);
  useLayoutEffect(resize, [value, capped, resize]);
  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        registerRef(el);
      }}
      value={value}
      rows={1}
      onChange={(e) => {
        onChange(e);
        resize();
      }}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={className}
    />
  );
}

function OutlineEditor({
  rows,
  inputRefs,
  descCapped,
  onText,
  onKeyDown,
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

/* ---------------- committed ---------------- */

interface CardHandlers {
  taskMap: Record<string, Task>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onStatus: (id: string, s: TaskStatus) => void;
  onAssign: (id: string, patch: { assigneeIds: string[] }) => void;
  onImportance: (id: string, v: Importance) => void;
  onMove: (dragId: string, targetId: string, pos: DropPos) => void;
  /** Toggle the viewer as an assignee (SPACE hover shortcut). */
  onAssignSelf: (id: string) => void;
  /** Delete the task with an undo window (DELETE hover shortcut). */
  onDelete: (id: string) => void;
  /** Create a subtask under this task (from the hover "+ Subtask" button). */
  onAddSubtask: (parentId: string, title: string) => void;
  dropHint: { id: string; pos: "before" | "after" } | null;
  setDropHint: (h: { id: string; pos: "before" | "after" } | null) => void;
}

/** One task card + its children, rendered recursively (arbitrary depth). */
function TaskCard({ unit, depth, h }: { unit: TaskUnit; depth: number; h: CardHandlers }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [addingSub, setAddingSub] = useState(false);
  const id = unit.taskId;
  const t = id ? h.taskMap[id] : undefined;
  const done = t?.status === "done";
  // "D" on the hovered card toggles done: not-done → done (via the checkbox's
  // old /complete path), done → building (setStatus clears completedAt).
  useCardShortcut(cardRef, "d", () => {
    if (!id) return;
    if (done) h.onStatus(id, "building");
    else h.onToggle(id);
  });
  // "1" / "2" on the hovered card set importance directly (Elevated / High) —
  // the number shortcuts alongside "I"'s full picker.
  useCardShortcut(cardRef, "1", () => id && h.onImportance(id, 1));
  useCardShortcut(cardRef, "2", () => id && h.onImportance(id, 2));
  // SPACE toggles the viewer as an assignee. Fires in capture + stopPropagation
  // (via useCardShortcut), so it intercepts the canvas space-to-pan only while a
  // card is hovered — space still pans everywhere else.
  useCardShortcut(cardRef, " ", () => id && h.onAssignSelf(id));
  // DELETE / Backspace removes the task (with a ~5s undo toast). Beats the canvas
  // editor's own Delete (which removes selected NODES) since it's hover-scoped.
  useCardShortcut(cardRef, "delete", () => id && h.onDelete(id));
  useCardShortcut(cardRef, "backspace", () => id && h.onDelete(id));
  if (!id || !t) return null;
  const ic = IMPORTANCE_CARD[t.importance ?? 0];
  // Status ring + corner badge — canvas only, and only for "started" statuses
  // (analyzing/analyzed/building/review). Backlog/todo/done are absent from the
  // map, so they get no ring/badge (done keeps its green wash below).
  const badge = STATUS_CANVAS_BADGE[t.status];
  const statusTone = STATUS_TONE[t.status];
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
          e.stopPropagation(); // over a card → not the section's blank-area zone
          h.setDropHint({ id, pos: half(e) });
        }}
        onDragLeave={() => h.dropHint?.id === id && h.setDropHint(null)}
        onDrop={(e) => {
          e.stopPropagation(); // a card handled it — don't also fire the body zone
          const dragId = e.dataTransfer.getData(SECTION_DND_MIME);
          const pos = half(e);
          h.setDropHint(null);
          if (dragId && dragId !== id) h.onMove(dragId, id, pos);
        }}
        // The whole card is the open target (not just the title). Interactive
        // children — QuickStatus/QuickAssign triggers, the title button — stop
        // their own clicks from bubbling here, so they don't also open the task.
        onClick={() => h.onOpen(id)}
        className={[
          "group/card relative cursor-pointer rounded-lg border px-2 py-1.5 transition-colors",
          done
            ? "border-buff/40 bg-buff-soft hover:border-buff/60"
            : `${ic.border} ${ic.bg} ${ic.hover}`,
          // Status ring (outline, not ring — avoids clashing with the drop-hint
          // box-shadow below). Follows the rounded corners.
          badge ? `outline outline-[3px] outline-offset-2 ${statusTone.outline}` : "",
          hint === "before" ? "shadow-[inset_0_2px_0_0_var(--color-accent)]" : "",
          hint === "after" ? "shadow-[inset_0_-2px_0_0_var(--color-accent)]" : "",
        ].join(" ")}
      >
        {badge ? (
          <span
            className={`absolute -top-2 right-2 z-10 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white ${statusTone.dot}`}
          >
            {badge}
          </span>
        ) : null}
        {/* Hover-revealed "+ Subtask" — top-right, below any status badge. Opens
            the nested composer under this card. */}
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setAddingSub(true);
          }}
          title="Add subtask"
          className={[
            "absolute right-1.5 z-20 hidden items-center gap-0.5 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-muted shadow-sm hover:border-accent hover:text-accent group-hover/card:flex",
            badge ? "top-3" : "top-1.5",
          ].join(" ")}
        >
          <span className="leading-none">+</span> Subtask
        </button>
        <TaskCardBody task={t} h={h} />
      </div>
      {unit.children.length || addingSub ? (
        <div className="mt-1.5 space-y-1.5">
          {unit.children.map((c) => (
            <TaskCard key={c.taskId ?? c.title} unit={c} depth={depth + 1} h={h} />
          ))}
          {addingSub ? (
            <div style={{ marginLeft: 12 }}>
              <InlineTaskComposer
                label="Subtask"
                onSubmit={(title) => h.onAddSubtask(id, title)}
                onClose={() => setAddingSub(false)}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Inline task/subtask composer — the "+ Add task" / "+ Subtask" input. Mirrors
 * the kanban AddCard UX: Enter creates and CLEARS but keeps the input open for
 * rapid entry; Esc or an empty blur closes it.
 *
 * Two modes: self-managed (no `onClose`) toggles its own button ↔ input, used
 * for the always-present bottom composer; controlled-open (`onClose` given) is
 * mounted already editing by its parent, and closing calls `onClose` to unmount
 * — used for the per-card subtask composer.
 */
function InlineTaskComposer({
  label,
  onSubmit,
  onClose,
}: {
  label: string;
  onSubmit: (title: string) => void;
  onClose?: () => void;
}) {
  const controlled = !!onClose;
  const [editing, setEditing] = useState(controlled);
  const [text, setText] = useState("");

  const close = () => {
    setText("");
    if (controlled) onClose?.();
    else setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-faint hover:bg-surface-3 hover:text-muted"
      >
        <span className="text-sm leading-none">+</span> {label}
      </button>
    );
  }

  return (
    <input
      autoFocus
      value={text}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && text.trim()) {
          onSubmit(text.trim());
          setText(""); // keep open for rapid entry
        } else if (e.key === "Escape") {
          close();
        }
      }}
      onBlur={() => {
        if (!text.trim()) close();
      }}
      placeholder={`${label} name, then Enter…`}
      className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
    />
  );
}

function CommittedList({
  units,
  taskMap,
  onOpen,
  onToggle,
  onStatus,
  onAssign,
  onImportance,
  onMove,
  onAssignSelf,
  onDelete,
  onAddTask,
  onAddSubtask,
  onDropIntoSection,
}: {
  units: TaskUnit[];
  taskMap: Record<string, Task>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onStatus: (id: string, s: TaskStatus) => void;
  onAssign: (id: string, patch: { assigneeIds: string[] }) => void;
  onImportance: (id: string, v: Importance) => void;
  onMove: (dragId: string, targetId: string, pos: DropPos) => void;
  onAssignSelf: (id: string) => void;
  onDelete: (id: string) => void;
  onAddTask: (title: string) => void;
  onAddSubtask: (parentId: string, title: string) => void;
  /** Drop a card into THIS section's blank area (or an empty section) — lands it
   *  at the end as a top-level card, moving it (and its subtree) here. */
  onDropIntoSection: (dragId: string) => void;
}) {
  const [dropHint, setDropHint] = useState<{ id: string; pos: "before" | "after" } | null>(null);
  // True while a section-task drag hovers the list's blank area (not a card) —
  // draws a dashed ring so it reads as "drop here to move into this section".
  const [overSection, setOverSection] = useState(false);

  const h: CardHandlers = { taskMap, onOpen, onToggle, onStatus, onAssign, onImportance, onMove, onAssignSelf, onDelete, onAddSubtask, dropHint, setDropHint };
  return (
    <div
      // Section-level drop zone. Card drops stopPropagation, so this fires only
      // for drops on the blank area — appending the dragged subtree here. Works
      // for empty sections too (no cards to target).
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SECTION_DND_MIME)) return;
        e.preventDefault();
        setOverSection(true);
      }}
      onDragLeave={(e) => {
        // Ignore leaves into child elements — only clear when truly exiting.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOverSection(false);
      }}
      onDrop={(e) => {
        setOverSection(false);
        const dragId = e.dataTransfer.getData(SECTION_DND_MIME);
        if (dragId) onDropIntoSection(dragId);
      }}
      className={[
        "min-h-16 space-y-1.5 rounded-lg transition-colors",
        overSection ? "outline-dashed outline-2 outline-offset-2 outline-accent/60" : "",
      ].join(" ")}
    >
      {units.map((u) => (
        <TaskCard key={u.taskId ?? u.title} unit={u} depth={0} h={h} />
      ))}
      {/* Always-present "+ Add task" composer at the bottom of the list. */}
      <InlineTaskComposer label="Add task" onSubmit={onAddTask} />
    </div>
  );
}
