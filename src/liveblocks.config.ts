/*
  Liveblocks type configuration for the realtime canvas.

  Augments the global `Liveblocks` interface so every `@liveblocks/react` hook
  (useStorage, useMutation, useOthers, presence, …) is fully typed without a
  per-room context. One room per canvas (`canvas:<id>`); the whole team can join
  any room (authorized in /api/liveblocks-auth).

  - Storage  — the shared, conflict-free source of truth: a LiveMap of nodes,
    each a LiveObject so two people editing different fields merge cleanly.
  - Presence — ephemeral per-user state: live cursor (in CANVAS coordinates so
    it's viewport-independent), the ids they currently have selected, and where
    their screen is pointed (so you can click a peer and adopt their view).
  - UserMeta — identity attached at auth time, used to label cursors.
*/

import type { Json, LiveMap, LiveObject } from "@liveblocks/client";
import type { CanvasNodeKind } from "@/lib/types";

/** The persisted shape of one node inside Liveblocks storage. Mirrors the
 *  `CanvasNode` type / `canvas_nodes` row (minus server-managed timestamps).
 *  A `type` (not `interface`) so it satisfies Liveblocks' LSON index signature. */
export type StoredNode = {
  id: string;
  kind: CanvasNodeKind;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string | null;
  position: number;
  data: Record<string, Json>;
};

declare global {
  interface Liveblocks {
    Presence: {
      /** Cursor in canvas coordinates, or null when off-canvas. */
      cursor: { x: number; y: number } | null;
      /** Node ids this user currently has selected. */
      selection: string[];
      /** What this user's screen is pointed at: the canvas point at the CENTRE
       *  of their viewport, plus their zoom. Peers click their avatar to adopt
       *  it. Centre + scale rather than the raw pan offsets, which depend on
       *  window size — a laptop and a large monitor sharing offsets would land
       *  on different content. null until their first broadcast. */
      view: { cx: number; cy: number; scale: number } | null;
      /** What this user is editing, or null. Ephemeral — auto-released on
       *  disconnect.
       *
       *  `taskId` + `field` is the original soft field-lock: peers highlight it
       *  and disable that input so two people don't clobber the same field.
       *
       *  The outline ("text view") adds the rest. Rows there are independent task
       *  FIELDS, so peers edit different rows freely; the fields below decorate
       *  that (a ring on their row, their caret inside it) AND carry the per-row
       *  lock, because two people in ONE row is the single case that cannot merge.
       *  See `useRowLock` — the claim IS this presence entry, so it expires with
       *  the tab and needs no server state.
       *    • `row`  — the field they're in: a task id for a title row, or
       *      `<taskId>#desc` for a description block.
       *    • `caret` — their character offset in that row.
       *    • `len` — the length of THEIR copy of the text, so a peer whose copy
       *      hasn't caught up yet can skip drawing rather than draw the caret in
       *      the wrong place.
       *    • `since` — when they entered `row`. Earliest claim owns it, tie-broken
       *      on connection id, so every client resolves the same owner without
       *      asking anyone.
       *    • `typingAt` — their last keystroke. An owner idle longer than
       *      `PARK_MS` is "parked": still shown, but no longer blocking, so a
       *      forgotten caret can't hold a row hostage.
       *    • `override` — a field this user is deliberately taking over. Beats
       *      seniority; the previous owner flushes its pending text and yields. */
      editing:
        | {
            taskId: string;
            field: string;
            row?: string;
            caret?: number;
            len?: number;
            since?: number;
            typingAt?: number;
            override?: string | null;
          }
        | null;
    };
    Storage: {
      nodes: LiveMap<string, LiveObject<StoredNode>>;
    };
    UserMeta: {
      id: string;
      info: {
        name: string;
        color: string;
      };
    };
    /** Fire-and-forget room events so peers update instantly instead of waiting
     *  for the ≤2s version poll:
     *   - `tasks-changed`: a structural edit happened — peers refetch from Postgres.
     *   - `task-patch`: a batched field delta (Phase 2) — peers apply it directly
     *     to their taskMap without a DB read (the write is deferred ~10s).
     *   - `canvas-notes-changed`: a sticky note on THIS canvas was added,
     *     moved, or resolved (Postgres-backed, not Liveblocks storage — see
     *     `task_notes`) — peers reload just this canvas's notes. Kept
     *     separate from `tasks-changed` so a sticky drag doesn't trigger a
     *     full task/project refetch for everyone in the room. */
    RoomEvent:
      | { type: "tasks-changed" }
      | { type: "task-patch"; taskId: string; patch: Record<string, Json> }
      | { type: "canvas-notes-changed" };
  }
}

export {};
