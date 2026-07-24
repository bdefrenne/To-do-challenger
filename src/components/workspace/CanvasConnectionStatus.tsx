"use client";

/**
 * Surfaces the Liveblocks room's connection health ON the canvas.
 *
 * The canvas renders purely from the realtime room (CanvasEditor reads
 * `useStorage`), and Postgres only seeds a brand-new room — so if the room
 * fails to connect (auth non-200, the 501 when LIVEBLOCKS_SECRET_KEY is unset,
 * plan/connection limits, a blocked WebSocket, or an unrecoverable drop) the
 * editor would otherwise show a plain empty canvas with no hint anything broke.
 * That's how a teammate can see the task list but a blank canvas.
 *
 * This overlay makes the failure visible instead:
 *   • healthy (connected + storage loaded) → renders nothing
 *   • connecting / reconnecting            → small non-blocking pill
 *   • hard failure                         → blocking card with the real error
 *
 * It must be mounted INSIDE the <RoomProvider> so the room hooks have context.
 * (No Postgres fallback here by design — we only surface the error.)
 */

import { useState } from "react";
import {
  useStatus,
  useErrorListener,
  useLostConnectionListener,
  useStorage,
} from "@liveblocks/react";

export function CanvasConnectionStatus() {
  const status = useStatus();
  // useStorage returns null until storage has actually synced from the room.
  const storageLoaded = useStorage((root) => root.nodes) != null;
  const [error, setError] = useState<{ message: string; code?: number } | null>(null);
  const [lost, setLost] = useState<"lost" | "failed" | null>(null);

  useErrorListener((err) => {
    // Room-connection errors carry a numeric code on the context; surface it
    // to help diagnose (e.g. auth failures, room full / plan limits).
    const code = (err.context as { code?: number } | undefined)?.code;
    setError({ message: err.message || "Unknown Liveblocks error", code });
  });

  useLostConnectionListener((event) => {
    if (event === "restored") setLost(null);
    else setLost(event); // "lost" (retrying) | "failed" (gave up)
  });

  // Fully connected with storage in hand → healthy: render nothing and ignore
  // any stale error/lost flag from an earlier cycle (a genuine re-break fires a
  // fresh error/status change). Avoids resetting state in an effect.
  if (status === "connected" && storageLoaded) return null;

  const hardFailure =
    error != null || lost === "failed" || status === "disconnected";
  const reconnecting =
    !hardFailure && (status === "reconnecting" || lost === "lost");
  const connecting =
    !hardFailure &&
    !reconnecting &&
    (status === "connecting" || status === "initial" || !storageLoaded);

  if (hardFailure) {
    return (
      <div className="absolute inset-0 z-50 grid place-items-center bg-bg/70 p-6 backdrop-blur-sm">
        <div className="max-w-sm rounded-lg border border-nerf bg-surface p-5 text-center shadow-lg">
          <p className="text-sm font-semibold text-fg">Can’t load the live canvas</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            The realtime connection to this canvas failed, so its contents
            can’t be shown. Nothing is lost — the canvas is saved — but the live
            room has to connect to display it.
          </p>
          {error?.message && (
            <p className="mt-3 break-words rounded bg-nerf-soft px-2 py-1.5 text-left font-mono text-[11px] text-nerf">
              {error.message}
              {error.code != null ? ` (code ${error.code})` : ""}
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (connecting || reconnecting) {
    return (
      <div className="pointer-events-none absolute left-1/2 top-3 z-50 -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-full border border-border bg-surface/90 px-3 py-1 text-xs text-muted shadow-sm backdrop-blur">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-adjust" />
          {reconnecting ? "Reconnecting…" : "Connecting…"}
        </div>
      </div>
    );
  }

  return null;
}
