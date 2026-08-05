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
      /** The task field this user is currently editing (a soft field-lock), or
       *  null. Peers highlight it and disable that input so two people don't
       *  clobber the same field. Ephemeral — auto-released on disconnect. */
      editing: { taskId: string; field: string } | null;
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
