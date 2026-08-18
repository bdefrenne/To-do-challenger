"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type OutlineRow,
  newRow,
  unitsToRows,
  flattenUnits,
  parentRowAt,
  descOwnerAt,
  foldedDescriptionFor,
  siblingPositionAt,
  mergeOutlineRows,
  rowFieldKey,
  type TaskUnit,
} from "@/lib/outline";
import type { TaskPlacement } from "@/lib/types";
import { useWorkspace, type TaskNode } from "./WorkspaceContext";

/** Where a ROOT line's task is filed when the outline creates it. A canvas
 *  Section states a pin (`canvasSectionId`); the project Boards view states a
 *  bucket by name (`placement`) and lets the server resolve the pin, since it has
 *  no canvas mounted. Nested lines carry neither — a subtask inherits its
 *  parent's placement. */
export type OutlineRootTarget = {
  canvasSectionId?: string | null;
  placement?: TaskPlacement;
};

/** How long after a structural edit (nest, reorder, delete) the ops are sent.
 *  Text doesn't wait for this — it streams per keystroke (see `persistText`). */
const STRUCT_COMMIT_MS = 600;
/** How long a typed character may live only in the browser. `editTaskLive`'s own
 *  window is 10s, tuned for the task modal; the outline is where tasks get
 *  CREATED in bulk, so it forces a flush sooner. */
const TEXT_FLUSH_MS = 4000;
/** Creates and structural ops both need peers to refetch (a new task cannot ride
 *  a field patch — `applyRemotePatch` ignores ids it does not have). One refetch
 *  per typed line was the lag when creating tasks, so they coalesce into one. */
const REFRESH_COALESCE_MS = 500;

/**
 * The outline ("text view") authoring machine, surface-agnostic.
 *
 * Text mode is one editable document over a LIST of tasks: type lines, Tab to
 * nest or turn a line into a description, and it saves to real tasks. It was
 * written for the canvas Section; the project Boards view runs the same view over
 * a board × bucket column, so the machine lives here and each surface supplies
 * only what differs: the tree to seed from, the tasks the list owns, and where a
 * new root line is filed.
 *
 * **This used to persist by diffing the whole row list** — creates by level, then
 * content updates, dense positions `0,1,2…` reasserted per sibling group, and
 * deletes inferred from an id going missing. That works for one author and
 * destroys data with two: each save asserts "the list looks like MY rows", so the
 * slower author silently reverts the other's structure. It's why text mode was
 * locked to one person at a time.
 *
 * It is now **op-based**: every write says what the user did to ONE row, so two
 * people editing different rows commute and neither needs a lock.
 *
 *   • **Text** goes out per keystroke through `editTaskLive` — optimistic, peers
 *     get a `task-patch` broadcast with no DB read, the Postgres write batches.
 *   • **Structure** accumulates real ops (create / move / delete) and commits
 *     them shortly after; positions are FRACTIONAL midpoints between the row's
 *     neighbours, so inserting never renumbers a group.
 *   • **A task is deleted only when someone deletes its line.** Absence proves
 *     nothing any more — a stale row list can't take anything down with it, and
 *     `knownIdsRef` is now an assertion rather than the safety mechanism.
 *   • **A row is one task FIELD** (a title, or a task's whole folded
 *     description). Different rows never collide; the same row is
 *     last-writer-wins, and the caller surfaces that with presence.
 *
 * Still enforced: saves only run while `active`, so a remount in card mode can't
 * flush anything.
 */
export function useOutlineDraft({
  active,
  units,
  scopeNodes,
  boardId,
  rootTarget,
  peersPresent = false,
  onLeave,
}: {
  /** True while the caller is showing text mode — the master switch. */
  active: boolean;
  /** The list's current tree, as rendered. Seeds the rows, and re-seeds them when
   *  a peer's edit lands while nothing local is pending and we aren't focused. */
  units: TaskUnit[];
  /** The tasks this list owns — the position/parent lookups are scoped to these,
   *  so one list's ops can't disturb another's. */
  scopeNodes: TaskNode[];
  boardId: string | null;
  rootTarget: OutlineRootTarget;
  /** Is anyone else in this list's outline right now? Only then is it worth
   *  broadcasting every keystroke — a peer applying a text patch rebuilds the unit
   *  tree in every section on their canvas, so paying that when nobody is watching
   *  the text is pure cost. Presence answers it; default false keeps the
   *  single-user surfaces (the Boards view) cheap. */
  peersPresent?: boolean;
  /** Escape in the editor — the caller returns to card mode. */
  onLeave: () => void;
}) {
  const ws = useWorkspace();
  const peersRef = useRef(peersPresent);
  useEffect(() => void (peersRef.current = peersPresent), [peersPresent]);
  // Kept in refs so the async op paths never close over a stale render.
  const rootTargetRef = useRef(rootTarget);
  const scopeRef = useRef(scopeNodes);
  useEffect(() => {
    rootTargetRef.current = rootTarget;
    scopeRef.current = scopeNodes;
  });
  /** Ids this session has seen (baseline + what it created). A delete op naming
   *  anything else is a bug, not a user intent — see `commitStructure`. */
  const knownIdsRef = useRef<Set<string>>(new Set());

  const [rows, setRows] = useState<OutlineRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [focus, setFocus] = useState<{ key: string; caret: number } | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement | HTMLTextAreaElement>>(new Map());

  // `rowsRef` is the AUTHORITY, not a mirror of the last render.
  //
  // Every keystroke reads it to build the next row list, and async work (a create
  // resolving with its new task id) writes it. Those two used to disagree: the id
  // write-back went to React state only, so a keystroke landing before that render
  // committed rebuilt from the stale ref and DROPPED the id — the row looked
  // unbound again and `pumpCreates` made a SECOND task ("I want you" + "I want you
  // to do this"). An effect syncing the ref back from `rows` was part of the same
  // trap: two renders behind one ref, and the older array wins.
  //
  // So there is exactly one way to change rows — `writeRows` — and it updates the
  // ref and the state together, always deriving from the ref.
  const rowsRef = useRef(rows);
  const writeRows = useCallback((update: (current: OutlineRow[]) => OutlineRow[]) => {
    const next = update(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
    return next;
  }, []);
  const activeRef = useRef(active);
  useEffect(() => void (activeRef.current = active), [active]);

  /* ---------------- the op log ---------------- */
  // Task ids whose parent or order the USER changed (Tab, Shift+Tab, Enter split,
  // merge). Only these get a move op — never a row that merely looks out of place
  // against our possibly-stale copy of the DB.
  const movedRef = useRef<Set<string>>(new Set());
  // Task ids the USER deleted (emptied a line, merged a bound row away, turned a
  // task into its parent's description).
  const deletedRef = useRef<Set<string>>(new Set());
  // Row keys with a create in flight, and the latest text typed while it flies —
  // the create carries the first character, so the rest has nowhere to go until
  // the id comes back.
  const creatingRef = useRef<Set<string>>(new Set());
  // Row keys this session has ALREADY created a task for. `creatingRef` only
  // covers the in-flight window and the row's own `taskId` covers the settled
  // case, but both are timing-dependent — and the failure mode here is a
  // duplicate task on someone's board, so the invariant gets its own record:
  // one row key, one create, ever.
  const createdKeysRef = useRef<Set<string>>(new Set());
  const bufferRef = useRef<Map<string, string>>(new Map());
  const pumpingRef = useRef(false);
  // `pumpCreates` may need to retract a task the user abandoned mid-flight, but
  // the structural scheduler is declared below it. Hold it here.
  const kickStructRef = useRef<(() => void) | null>(null);
  const structTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef(0);

  const busy = useCallback((delta: number) => {
    inflightRef.current = Math.max(0, inflightRef.current + delta);
    setSaving(inflightRef.current > 0);
  }, []);

  // Positions we have just written but not yet read back. `scopeNodes` only
  // learns about a create/move after a refetch, so without this the NEXT row
  // computes its midpoint from stale neighbours — type three new lines quickly and
  // they can all land on the same position. (Order then falls to the createdAt
  // tiebreak, which is right for appending and wrong for a mid-list insert.)
  const localPosRef = useRef<Map<string, number>>(new Map());
  // Fields typed but not yet confirmed by the server. The outline writes text
  // non-optimistically (see `persistText`), so `units` does NOT contain your own
  // last sentence until a flush completes — a re-seed triggered by a PEER's edit
  // would otherwise revert it on your screen. Cleared once the flush lands, since
  // `flushEdits` refetches and `taskMap` then agrees with us.
  const dirtyFieldsRef = useRef<Set<string>>(new Set());
  // Tasks we created that the server hasn't echoed back into `units` yet. Until it
  // does, their absence means "not fetched", NOT "deleted by a peer".
  const unconfirmedRef = useRef<Set<string>>(new Set());
  // A coalesced refresh is armed or running, so `units` is knowably behind us.
  const refreshPendingRef = useRef(false);
  /** A task's current position: what we last wrote, else what the DB last told us. */
  const positionOf = useCallback((taskId: string) => {
    return localPosRef.current.get(taskId) ?? scopeRef.current.find((n) => n.id === taskId)?.position;
  }, []);

  /** One refetch for a burst of structural work. `ws.refresh()` is a whole-
   *  workspace fetch that ALSO tells peers to refetch, so calling it per created
   *  row is what made typing a list crawl. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshPendingRef.current = true;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void ws.refresh().finally(() => {
        refreshPendingRef.current = false;
      });
    }, REFRESH_COALESCE_MS);
  }, [ws]);

  /** Nothing local is waiting to be written. Gates the live re-seed, which
   *  rebuilds every row from the DB and would otherwise throw local work away.
   *  A row with text but no task id counts: either its create is still coming or
   *  it FAILED, and in both cases those are characters the user typed. */
  const hasPendingOps = () =>
    movedRef.current.size > 0 ||
    deletedRef.current.size > 0 ||
    creatingRef.current.size > 0 ||
    rowsRef.current.some((r) => !r.desc && !r.taskId && r.text.trim().length > 0);

  /* ---------------- enter / seed ---------------- */
  const seed = useCallback(() => {
    const seeded = unitsToRows(units);
    const next = seeded.length ? seeded : [newRow(0)];
    knownIdsRef.current = new Set(
      flattenUnits(units)
        .map((f) => f.unit.taskId)
        .filter((id): id is string => !!id),
    );
    movedRef.current.clear();
    deletedRef.current.clear();
    localPosRef.current.clear();
    createdKeysRef.current.clear();
    writeRows(() => next);
    setFocus({ key: next[next.length - 1].key, caret: next[next.length - 1].text.length });
  }, [units, writeRows]);

  // Reposition the caret only when `focus` changes (after a structural edit: new
  // row, merge, role cycle, arrow nav). Depending on `rows` here would re-run on
  // every keystroke and yank the caret to the start — typing the line in reverse.
  useEffect(() => {
    if (!focus) return;
    const el = inputRefs.current.get(focus.key);
    if (el) {
      el.focus();
      const c = Math.min(focus.caret, el.value.length);
      el.setSelectionRange(c, c);
    }
  }, [focus]);

  /* ---------------- text: one field, per keystroke ---------------- */

  /** Force the batched text writes out sooner than `editTaskLive`'s own window. */
  const scheduleTextFlush = useCallback(() => {
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      void ws.flushEdits().then(() => dirtyFieldsRef.current.clear());
    }, TEXT_FLUSH_MS);
  }, [ws]);

  // One trailing throttle per FIELD. Typing is ~8 keystrokes/second and each send
  // touches the overlay, the pending-write map and (with peers) the room, so
  // coalescing to ~80ms costs nothing perceptible and cuts the work by an order of
  // magnitude. Trailing, so the final character always lands.
  // The pending send is kept WITH its timer so a flush can run exactly the fields
  // that are waiting — re-sending every row instead would re-persist untouched
  // tasks on every Esc.
  const sendTimers = useRef<Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>>(
    new Map(),
  );
  const sendField = useCallback((key: string, run: () => void) => {
    const existing = sendTimers.current.get(key);
    if (existing) clearTimeout(existing.timer);
    // Wider window when a peer is watching, because then each send also costs
    // THEM a `taskMap` write, and `useSectionUnits` depends on it — one patch
    // rebuilds every section's unit tree on their canvas (TD-132). 150ms is still
    // inside "instant" for a remote caret and halves what we make them do.
    const delay = peersRef.current ? 150 : 80;
    const timer = setTimeout(() => {
      sendTimers.current.delete(key);
      run();
    }, delay);
    sendTimers.current.set(key, { timer, run });
  }, []);
  /** Run every throttled send now. Called before anything that must not lose the
   *  last character: Esc, leaving text mode, unmount. */
  const flushSends = useCallback(() => {
    for (const [key, { timer, run }] of [...sendTimers.current]) {
      clearTimeout(timer);
      sendTimers.current.delete(key);
      run();
    }
  }, []);

  /** Send the field a row owns. A title row writes `title`; a description row
   *  writes its OWNER's whole folded description (every desc line under that
   *  task), because that is the single column they share.
   *
   *  Deliberately NOT optimistic: the row on screen already comes from `rows`, and
   *  writing `taskMap` per keystroke rebuilt every section's unit tree
   *  (`useSectionUnits` depends on it) — which is what made typing lag. The value
   *  reaches `taskMap` at the flush instead. */
  const persistText = useCallback(
    (next: OutlineRow[], index: number) => {
      const row = next[index];
      if (!row) return;
      if (row.desc) {
        const ownerIndex = next.findIndex((r) => r === descOwnerAt(next, index));
        const owner = ownerIndex >= 0 ? next[ownerIndex] : null;
        if (!owner?.taskId) return; // owner not created yet — its create carries the text
        const id = owner.taskId;
        // "" is how this app clears a description through `editTaskLive` (same as
        // the task modal) — `TaskEdit.description` has no null.
        const value = foldedDescriptionFor(next, ownerIndex);
        dirtyFieldsRef.current.add(`${id}#desc`);
        sendField(`${id}#desc`, () =>
          ws.editTaskLive(
            id,
            { description: value },
            { optimistic: false, broadcast: peersRef.current },
          ),
        );
        scheduleTextFlush();
        return;
      }
      const title = row.text.trim();
      if (!row.taskId || !title) return; // unbound → `pumpCreates`; empty → nothing valid to send
      const id = row.taskId;
      dirtyFieldsRef.current.add(id);
      sendField(id, () =>
        ws.editTaskLive(id, { title }, { optimistic: false, broadcast: peersRef.current }),
      );
      scheduleTextFlush();
    },
    [ws, scheduleTextFlush, sendField],
  );

  /* ---------------- structure: creates ---------------- */

  /** Create the tasks for rows that have text but no id yet, oldest first.
   *
   *  Serialized on purpose. Two siblings created in parallel would both read the
   *  same neighbours and compute the SAME fractional position; and a child can't
   *  be created before its parent has an id, so each create can unblock the next.
   *  Re-entrant calls just mark the pump dirty and return. */
  const pumpCreates = useCallback(async () => {
    if (pumpingRef.current || !activeRef.current) return;
    const board = boardId;
    if (!board) return;
    pumpingRef.current = true;
    busy(1);
    let created = false;
    try {
      for (;;) {
        const current = rowsRef.current;
        const index = current.findIndex((r, i) => {
          if (r.desc || r.taskId || creatingRef.current.has(r.key)) return false;
          if (createdKeysRef.current.has(r.key)) return false; // already has a task
          if (!r.text.trim()) return false;
          const parent = parentRowAt(current, i);
          return !parent || !!parent.taskId; // wait for an unbound ancestor
        });
        if (index === -1) break;
        const row = current[index];
        const parent = parentRowAt(current, index);
        const position = siblingPositionAt(current, index, positionOf);
        const description = foldedDescriptionFor(current, index);
        creatingRef.current.add(row.key);
        createdKeysRef.current.add(row.key);
        bufferRef.current.set(row.key, row.text);
        const [result] = await ws.bulk([
          {
            op: "create",
            input: {
              title: row.text.trim(),
              description: description || undefined,
              boardId: board,
              parentId: parent?.taskId ?? undefined,
              position,
              // Only roots carry the pin/bucket — a subtask inherits its parent's.
              ...(parent ? {} : rootTargetRef.current),
            },
          },
        ]);
        creatingRef.current.delete(row.key);
        const id = result?.ok ? result.id : undefined;
        if (!id) {
          // Leave the row unbound and its text on screen — the user's characters
          // are never dropped for a failed create. `ws.bulk` already told them.
          // Release the one-create claim: this row genuinely has no task, so a
          // later attempt (Esc, next flush) should be allowed to try again.
          createdKeysRef.current.delete(row.key);
          bufferRef.current.delete(row.key);
          break;
        }
        created = true;
        unconfirmedRef.current.add(id);
        knownIdsRef.current.add(id);
        localPosRef.current.set(id, position);
        writeRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, taskId: id } : r)));
        bufferRef.current.delete(row.key);
        // What became of this row while the create was in the air? Read it LIVE —
        // the user kept typing, or erased it, or merged it away entirely, and the
        // task now exists either way.
        const live = rowsRef.current.find((r) => r.key === row.key);
        const latest = (live?.text ?? "").trim();
        if (!live || !latest) {
          // Abandoned: the line was merged away, or typed and erased before the
          // id came back. Retract the task rather than leave a one-character
          // orphan on the board — the whole reason creates wait for a character.
          deletedRef.current.add(id);
          kickStructRef.current?.();
          continue;
        }
        // Otherwise send the LATEST value, not a replay of every keystroke.
        if (latest !== row.text.trim()) ws.editTaskLive(id, { title: latest });
      }
      if (created) scheduleRefresh();
    } catch (err) {
      console.error("[outline] create failed", err);
    } finally {
      busy(-1);
      pumpingRef.current = false;
    }
  }, [boardId, ws, positionOf, busy, writeRows, scheduleRefresh]);

  /* ---------------- structure: moves + deletes ---------------- */

  const commitStructure = useCallback(async () => {
    if (structTimer.current) {
      clearTimeout(structTimer.current);
      structTimer.current = null;
    }
    if (!boardId || !activeRef.current) return;
    const current = rowsRef.current;
    const moves: unknown[] = [];
    const deletes: unknown[] = [];

    // Moves: only rows the user re-nested or re-ordered — plus the orphans-to-be
    // added by `noteDeleted` (see there). Never a row that merely looks misplaced
    // against our possibly-stale copy of the DB; that guess is what used to
    // revert peers.
    for (const id of movedRef.current) {
      if (deletedRef.current.has(id)) continue;
      const index = current.findIndex((r) => r.taskId === id);
      if (index === -1) continue;
      const parent = parentRowAt(current, index);
      const position = siblingPositionAt(current, index, positionOf);
      localPosRef.current.set(id, position);
      moves.push({
        op: "move",
        id,
        target: { parentId: parent?.taskId ?? null, position },
      });
    }
    // Deletes: only ids the user actually deleted, and only ones this session
    // knows. An id from nowhere means a bug upstream — log it, don't delete it.
    for (const id of deletedRef.current) {
      if (!knownIdsRef.current.has(id)) {
        console.error("[outline] refusing to delete an id this session never knew", id);
        continue;
      }
      deletes.push({ op: "delete", id });
    }
    movedRef.current.clear();
    deletedRef.current.clear();
    // MOVES BEFORE DELETES, and the server runs them in array order. `deleteTask`
    // promotes a dead task's children to root and re-stamps them at the END of
    // the group, so re-parenting them first means they are never orphaned at all.
    const ops = [...moves, ...deletes];
    if (!ops.length) return;

    busy(1);
    try {
      await ws.bulk(ops);
      // Structural change: peers need the new tree. Coalesced with any creates
      // from the same burst — keystrokes never come through here, which is the
      // whole point of the split.
      scheduleRefresh();
    } catch (err) {
      console.error("[outline] structural commit failed", err);
    } finally {
      busy(-1);
    }
  }, [boardId, ws, positionOf, busy, scheduleRefresh]);

  const scheduleStructCommit = useCallback(() => {
    if (structTimer.current) clearTimeout(structTimer.current);
    structTimer.current = setTimeout(() => void commitStructure(), STRUCT_COMMIT_MS);
  }, [commitStructure]);
  useEffect(() => void (kickStructRef.current = scheduleStructCommit), [scheduleStructCommit]);

  /** Record that the user moved a bound row, and that a create may be possible. */
  const noteMoved = useCallback(
    (taskId: string | null) => {
      if (taskId) movedRef.current.add(taskId);
      scheduleStructCommit();
    },
    [scheduleStructCommit],
  );
  /** The user deleted a line. Its task dies — and everything nested UNDER it has
   *  to be re-parented, or it silently moves somewhere nobody asked for:
   *  `deleteTask` promotes a dead task's children to root and re-stamps them at
   *  the END of the group, so the screen would keep showing them nested while the
   *  database quietly moved them to the bottom.
   *
   *  This is the seam op-based saving opens. The old whole-list diff recomputed
   *  every row's parent, so it fixed collateral damage like this for free; ops
   *  only carry what the user touched, so the op has to carry its consequences.
   *
   *  `rows`/`index` describe the list AFTER the edit, where the deleted row is no
   *  longer a task (spliced out, or turned into a description) — so each
   *  descendant's `parentRowAt` already resolves to where it now belongs. */
  const noteDeleted = useCallback(
    (taskId: string | null, rows?: OutlineRow[], deletedIndent?: number, index?: number) => {
      if (!taskId) return;
      deletedRef.current.add(taskId);
      if (rows && index !== undefined && deletedIndent !== undefined) {
        for (let i = index; i < rows.length; i++) {
          const r = rows[i];
          if (!r.desc && r.indent <= deletedIndent) break; // out of the subtree
          if (!r.desc && r.taskId) movedRef.current.add(r.taskId);
        }
      }
      scheduleStructCommit();
    },
    [scheduleStructCommit],
  );

  /* ---------------- authoring: row edits ---------------- */

  const setText = useCallback(
    (key: string, text: string) => {
      const next = writeRows((rs) => rs.map((r) => (r.key === key ? { ...r, text } : r)));
      const index = next.findIndex((r) => r.key === key);
      if (index === -1) return;
      // A create in flight for this row: park the text, the pump sends the latest.
      if (creatingRef.current.has(key)) {
        bufferRef.current.set(key, text);
        return;
      }
      persistText(next, index);
      if (!next[index].desc && !next[index].taskId) void pumpCreates();
    },
    [persistText, pumpCreates, writeRows],
  );

  /** The deepest indent a task at `index` may take = (nearest task above)+1.
   *  -1 means there's no task above to nest under (the very first line). */
  const maxTaskIndent = (index: number) => {
    for (let i = index - 1; i >= 0; i--) if (!rows[i].desc) return rows[i].indent + 1;
    return -1;
  };

  /** Apply a row-list change, then re-persist the fields it touched. Keeping the
   *  two together is what stops a structural key silently losing text. */
  const applyRows = (
    nextRows: OutlineRow[],
    persistIndexes: number[] = [],
  ) => {
    writeRows(() => nextRows);
    persistIndexes.forEach((i) => persistText(nextRows, i));
  };

  const onRowKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    row: OutlineRow,
    index: number,
  ) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void flush();
      onLeave();
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
        const copy = rows.slice();
        if (before.trim()) {
          copy[index] = { ...row, text: before };
          copy.splice(index + 1, 0, ...inserts);
        } else {
          copy.splice(index, 1, ...inserts); // desc had only this line → replace it
        }
        // The owner's description lost a line, and a new task row appeared.
        applyRows(copy, [copy.findIndex((r) => r.desc && r.key === row.key)].filter((i) => i >= 0));
        const owner = descOwnerAt(copy, copy.findIndex((r) => r.key === bullet.key));
        if (owner) {
          const oi = copy.findIndex((r) => r.key === owner.key);
          if (oi >= 0 && owner.taskId)
            ws.editTaskLive(owner.taskId, {
              description: foldedDescriptionFor(copy, oi),
            });
        }
        void pumpCreates();
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
          applyRows(rows.map((r) => (r.key === row.key ? { ...r, indent: r.indent - 1 } : r)));
          noteMoved(row.taskId);
          setFocus({ key: row.key, caret: e.currentTarget.selectionStart ?? row.text.length });
        }
        return;
      }
      if (row.indent < max) {
        // Nest one level deeper (subtask / sub-subtask …).
        applyRows(rows.map((r) => (r.key === row.key ? { ...r, indent: r.indent + 1 } : r)));
        noteMoved(row.taskId);
      } else {
        // Already as deep as allowed → this line becomes the task's description.
        // The task itself stops existing: an explicit delete, and its text joins
        // the owner's description field.
        const copy = rows.map((r) =>
          r.key === row.key ? { ...r, desc: true, taskId: null } : r,
        );
        applyRows(copy);
        noteDeleted(row.taskId, copy, row.indent, index + 1);
        const di = copy.findIndex((r) => r.key === row.key);
        if (di >= 0) persistText(copy, di);
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
      const copy = rows.slice();
      copy[index] = { ...row, text: head };
      copy.splice(index + 1, 0, created);
      // The head's title changed, and the tail needs a task of its own.
      applyRows(copy, [index]);
      void pumpCreates();
      setFocus({ key: created.key, caret: 0 });
      return;
    }
    if (e.key === "Backspace" && (e.currentTarget.selectionStart ?? 0) === 0 && index > 0) {
      // Merge into the previous row (its id/role win); this row is dropped, so its
      // task — if it had one — is deliberately deleted.
      e.preventDefault();
      const prev = rows[index - 1];
      const mergedCaret = prev.text.length;
      const copy = rows.slice();
      copy[index - 1] = { ...prev, text: prev.text + row.text };
      copy.splice(index, 1);
      applyRows(copy, [index - 1]);
      noteDeleted(row.taskId, copy, row.indent, index);
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

  /* ---------------- flush ---------------- */

  /** Everything out now: pending creates, structural ops, and the batched text.
   *  Called on Esc, on leaving text mode, and on unmount. */
  const flush = useCallback(async () => {
    if (textTimer.current) clearTimeout(textTimer.current);
    // A trailing timer must never be the reason a character is lost.
    flushSends();
    await pumpCreates();
    await commitStructure();
    await ws.flushEdits();
  }, [pumpCreates, commitStructure, flushSends, ws]);

  useEffect(() => {
    return () => {
      // Only a genuine authoring session — never a committed section.
      if (activeRef.current) void flush();
    };
    // Flush-on-unmount only; re-arming on every identity change would fire it
    // mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live re-sync: fold peers' edits in while you keep typing.
  //
  // This used to bail whenever anything in the outline had focus, which meant two
  // people typing in one list never saw each other — both are always focused. Now
  // it MERGES per field (`mergeOutlineRows`): rows keep their keys so the caret's
  // DOM node survives, structure comes from the server, and the fields we must not
  // touch — the one the caret is in, plus anything typed and not yet confirmed —
  // keep our text.
  useEffect(() => {
    if (!active) return;
    // A create/move/delete of ours is in flight: its row list is mid-change and
    // the server's copy is knowably behind. Let it settle first.
    if (hasPendingOps()) return;
    // Our own refresh is on its way; merging against a copy of the tree we KNOW
    // predates our last write is how a freshly created subtask row disappeared
    // mid-keystroke.
    if (refreshPendingRef.current) return;
    const current = rowsRef.current;

    const protectedFields = new Set(dirtyFieldsRef.current);
    // Whatever the caret is in, even if untouched — re-seeding it would move the
    // caret under the user's fingers.
    const el = document.activeElement;
    const focusedKey = [...inputRefs.current.entries()].find(([, node]) => node === el)?.[0];
    if (focusedKey) {
      const index = current.findIndex((r) => r.key === focusedKey);
      const field = index >= 0 ? rowFieldKey(current, index) : null;
      if (field) protectedFields.add(field);
    }

    // No `[newRow(0)]` fallback here — `mergeOutlineRows` invents the blank row
    // when there is nothing at all, and inventing one on BOTH sides is what made
    // empty rows pile up without end.
    const seeded = unitsToRows(units);
    // Anything the server has now echoed is confirmed; the rest still needs
    // protecting from being read as a delete.
    const seenIds = new Set(seeded.map((r) => r.taskId).filter((id): id is string => !!id));
    unconfirmedRef.current.forEach((id) => {
      if (seenIds.has(id)) unconfirmedRef.current.delete(id);
    });
    const merged = mergeOutlineRows(
      seeded,
      current,
      protectedFields,
      focusedKey ?? null,
      unconfirmedRef.current,
    );
    knownIdsRef.current = new Set(
      flattenUnits(units)
        .map((f) => f.unit.taskId)
        .filter((id): id is string => !!id),
    );
    // Don't churn state (or the caret) when the merge changes nothing — this
    // effect runs on every `units` identity change, which includes our own writes.
    const same =
      merged.length === current.length &&
      merged.every(
        (r, i) =>
          r.key === current[i].key &&
          r.text === current[i].text &&
          r.indent === current[i].indent &&
          r.desc === current[i].desc &&
          r.taskId === current[i].taskId,
      );
    if (same) return;
    // Restore the caret after a merge that actually changed the list. Row keys are
    // preserved for matching fields, so the input usually survives — but a
    // reordered or re-inserted row can still drop focus, and losing it mid-word is
    // the worst thing this feature can do. Reuses the same `focus` machinery the
    // structural edits use.
    const caret =
      focusedKey && el instanceof HTMLTextAreaElement ? (el.selectionStart ?? 0) : null;
    writeRows(() => merged);
    if (focusedKey && caret !== null && merged.some((r) => r.key === focusedKey)) {
      setFocus({ key: focusedKey, caret });
    }
  }, [units, active, writeRows]);

  return {
    rows,
    saving,
    inputRefs,
    setText,
    onRowKeyDown,
    /** Open text mode: seed the rows from `units` and snapshot the known ids.
     *  The caller flips its own mode — this only prepares the draft. */
    seed,
    /** Send everything pending now (view toggle / Escape / unmount). */
    flush,
  };
}
