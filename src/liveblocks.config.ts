/*
  Liveblocks type configuration for the realtime canvas.

  Augments the global `Liveblocks` interface so every `@liveblocks/react` hook
  (useStorage, useMutation, useOthers, presence, …) is fully typed without a
  per-room context. One room per canvas (`canvas:<id>`); the whole team can join
  any room (authorized in /api/liveblocks-auth).

  - Storage  — the shared, conflict-free source of truth: a LiveMap of nodes,
    each a LiveObject so two people editing different fields merge cleanly.
  - Presence — ephemeral per-user state: live cursor (in CANVAS coordinates so
    it's viewport-independent) and the ids they currently have selected.
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
     *     to their taskMap without a DB read (the write is deferred ~10s). */
    RoomEvent:
      | { type: "tasks-changed" }
      | { type: "task-patch"; taskId: string; patch: Record<string, Json> };
  }
}

export {};
