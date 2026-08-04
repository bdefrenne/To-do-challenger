"use client";

/**
 * Single canvas — a full-viewport realtime editor. Loads the canvas (name +
 * nodes), then mounts the Liveblocks room: the whole team can join `canvas:<id>`
 * and edit together. Storage is seeded from Postgres via initialStorage the
 * first time a room is created; after that Liveblocks is the live source of
 * truth and the editor snapshots back to Postgres.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LiveMap, LiveObject, type Json } from "@liveblocks/client";
import { LiveblocksProvider, RoomProvider } from "@liveblocks/react";
import { CanvasEditor } from "@/components/workspace/CanvasEditor";
import { CanvasConnectionStatus } from "@/components/workspace/CanvasConnectionStatus";
import type { StoredNode } from "@/liveblocks.config";
import type { Canvas, CanvasNode } from "@/lib/types";

/**
 * Liveblocks bills *connection minutes* — wall-clock time a client holds an open
 * socket, idle or not. A canvas tab left in the background used to hold its
 * socket forever. With this set, a hidden tab with nothing pending parks the
 * socket (`@idle.zombie`) and the client re-opens it by itself when the tab is
 * shown again. Must stay a module constant: LiveblocksProvider freezes its
 * options into a single `createClient` on first render.
 *
 * The visible-but-untouched case (canvas parked on a second monitor) is NOT
 * covered here — the client only parks hidden tabs. See `useRoomIdlePause`.
 */
const BACKGROUND_KEEP_ALIVE_MS = 60_000;

function toStored(n: CanvasNode): StoredNode {
  return {
    id: n.id,
    kind: n.kind,
    content: n.content,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    color: n.color ?? null,
    position: n.position,
    data: (n.data ?? {}) as Record<string, Json>,
  };
}

export default function CanvasPage() {
  const { canvasId } = useParams<{ canvasId: string }>();
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState("");
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch(`/api/canvases/${canvasId}`);
      if (!alive) return;
      if (res.ok) {
        const { canvas } = await res.json();
        setCanvas(canvas);
        setName(canvas.name);
      } else {
        setMissing(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [canvasId]);

  const saveName = useCallback(
    (value: string) => {
      if (nameTimer.current) clearTimeout(nameTimer.current);
      nameTimer.current = setTimeout(() => {
        void fetch(`/api/canvases/${canvasId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: value.trim() || "Untitled canvas" }),
        });
      }, 600);
    },
    [canvasId],
  );

  // Seed Liveblocks storage from Postgres (only used when the room is new).
  const initialStorage = useMemo(
    () =>
      canvas
        ? {
            nodes: new LiveMap<string, LiveObject<StoredNode>>(
              (canvas.nodes ?? []).map((n) => [n.id, new LiveObject(toStored(n))]),
            ),
          }
        : null,
    [canvas],
  );

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <Link
          href="/canvas"
          className="rounded-md px-2 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          title="Back to canvases"
        >
          ←
        </Link>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            saveName(e.target.value);
          }}
          disabled={!canvas}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-sm font-semibold text-fg outline-none focus:bg-surface-2"
          placeholder="Untitled canvas"
        />
      </header>
      <div className="relative flex-1">
        {missing ? (
          <div className="grid h-full place-items-center">
            <p className="text-sm text-faint">Canvas not found.</p>
          </div>
        ) : !canvas || !initialStorage ? (
          <div className="grid h-full place-items-center">
            <p className="text-sm text-faint">Loading canvas…</p>
          </div>
        ) : (
          <LiveblocksProvider
            authEndpoint="/api/liveblocks-auth"
            backgroundKeepAliveTimeout={BACKGROUND_KEEP_ALIVE_MS}
          >
            <RoomProvider
              id={`canvas:${canvasId}`}
              initialPresence={{ cursor: null, selection: [], editing: null, view: null }}
              initialStorage={initialStorage}
            >
              <CanvasEditor canvasId={canvasId} canvasName={name} />
              <CanvasConnectionStatus />
            </RoomProvider>
          </LiveblocksProvider>
        )}
      </div>
    </div>
  );
}
