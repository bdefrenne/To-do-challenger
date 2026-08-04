"use client";

/**
 * Stops a canvas room from billing Liveblocks connection minutes while nobody is
 * actually using it.
 *
 * Liveblocks charges for wall-clock socket time, not activity. Two cases:
 *
 *   • tab HIDDEN     → the client parks the socket itself, via the
 *                      `backgroundKeepAliveTimeout` option set on
 *                      <LiveblocksProvider> in the canvas page. It also
 *                      re-opens it on its own when the tab comes back.
 *   • tab VISIBLE but untouched (canvas parked on a second monitor, an
 *                      unfocused-but-visible window) → the client never parks
 *                      that, because `visibilityState` is "visible". That's
 *                      this hook's job.
 *
 * Pausing is safe: `room.disconnect()` does not clear Storage, so the canvas
 * keeps rendering every node, local edits keep working and are replayed on
 * reconnect, and the canvas → Postgres snapshot is plain REST anyway. On resume
 * the client refetches Storage, so a paused view repairs itself.
 *
 * `room.disconnect()` parks the connection state machine in `@idle.initial`,
 * which leaves ONLY on an explicit `.connect()` — so once we pause, resuming is
 * entirely on us. Resume triggers: any user input, or the tab becoming visible.
 *
 * Must be called from inside a <RoomProvider>.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoom, useStatus, useSyncStatus } from "@liveblocks/react";

/** No input for this long, while the tab is VISIBLE → drop the socket. */
const IDLE_PAUSE_MS = 5 * 60_000;
/** How often we compare against the last activity stamp. */
const IDLE_POLL_MS = 30_000;
/** Ignore activity events this soon after the last one we recorded. */
const ACTIVITY_SAMPLE_MS = 1_000;

/** Prefix for the connection log. This is billing behaviour, so it's traceable
 *  in production too, not just dev — every socket open/close says why. */
const LOG = "[canvas room]";

/** Liveblocks' own status words, in plain language. "initial" especially: it's
 *  what the client calls its idle no-socket state, which you see both before the
 *  first connect AND after we disconnect on purpose (the one state the client
 *  never leaves by itself — hence resuming being our job).
 *
 *  Note there is NO status word for "parked in the background": when the client
 *  parks a hidden tab's socket itself (backgroundKeepAliveTimeout) it uses an
 *  internal zombie state that reports as connecting/reconnecting. So a
 *  connected → connecting → connected run with no `initial` and no "pausing"
 *  line is the client closing and reopening the socket on its own — which is
 *  why each line also prints the tab's visibility. */
const STATUS_NOTE: Record<string, string> = {
  initial: "no socket — not opened yet, or closed on purpose by the idle pause",
  connecting: "no live socket — opening one, or parked while the tab is hidden",
  connected: "live — billing realtime minutes",
  reconnecting: "no live socket — dropped or parked, will reopen",
  disconnected: "gave up — a real failure",
};

const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

export function useRoomIdlePause(): { paused: boolean; resume: () => void } {
  const room = useRoom();
  const status = useStatus();
  const syncStatus = useSyncStatus();

  // Our *intent* to be paused. What we expose is derived from this AND the real
  // connection status, so the UI can never claim "paused" over a live socket.
  const [pausedIntent, setPausedIntent] = useState(false);
  const intentRef = useRef(false);

  // Stamped on mount by the effect below (a clock read is impure, so it can't
  // happen during render); until then a 0 can't cause a pause, because the poll
  // only ever runs after that effect.
  const lastActivityRef = useRef(0);
  // Mirrored so the poll below can read them without re-arming the interval.
  const statusRef = useRef(status);
  const syncRef = useRef(syncStatus);
  useEffect(() => void (statusRef.current = status), [status]);
  useEffect(() => void (syncRef.current = syncStatus), [syncStatus]);

  // Every connection transition, whoever caused it — us, the client's own
  // hidden-tab parking, or a real network drop. The tab's visibility and how
  // long the previous status held are what tell those three apart, since the
  // status word alone can't (see STATUS_NOTE).
  const statusSinceRef = useRef(0);
  useEffect(() => {
    const now = Date.now();
    const held = statusSinceRef.current
      ? `held ${Math.round((now - statusSinceRef.current) / 1000)}s`
      : "first";
    statusSinceRef.current = now;
    console.info(
      `${LOG} ${status} — ${STATUS_NOTE[status] ?? "?"} · tab ${document.visibilityState} · prev ${held}`,
    );
  }, [status]);

  const resumeWith = useCallback(
    (reason: string) => {
      lastActivityRef.current = Date.now();
      if (!intentRef.current) return;
      intentRef.current = false;
      setPausedIntent(false);
      console.info(`${LOG} resuming (${reason}) — reopening the socket`);
      room.connect();
    },
    [room],
  );

  // Public resume is param-less: it's wired straight to a button's onClick, which
  // would otherwise pass the event in as the "reason".
  const resume = useCallback(() => resumeWith("clicked"), [resumeWith]);

  useEffect(() => {
    lastActivityRef.current = Date.now();

    const onActivity = () => {
      const now = Date.now();
      // pointermove fires ~60×/s and all we need to know is "something happened
      // recently", so throttle against the stamp itself — no extra bookkeeping.
      // Never throttle while paused, or the resume gesture could be swallowed.
      if (!intentRef.current && now - lastActivityRef.current < ACTIVITY_SAMPLE_MS) return;
      lastActivityRef.current = now;
      if (intentRef.current) resumeWith("user activity");
    };

    for (const type of ACTIVITY_EVENTS) {
      // capture: the canvas stops propagation in several places, and a window
      // capture listener also runs before React's root handlers — so a resume
      // is already in flight before the gesture mutates storage.
      // passive: never delay scrolling (per-listener, so the editor's own
      // non-passive wheel handler is unaffected).
      window.addEventListener(type, onActivity, { passive: true, capture: true });
    }

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      // Back on screen → reconnect right away, so a glance shows live data, and
      // don't count the time away as sitting-idle time.
      resumeWith("tab visible");
    };
    document.addEventListener("visibilitychange", onVisibility);

    const timer = setInterval(() => {
      if (intentRef.current) {
        // Self-heal: if something reconnected the room behind our back (the
        // provider re-entering the room, Fast Refresh, devtools), drop the
        // stale intent so idle pausing keeps working.
        if (statusRef.current === "connected") resumeWith("reconnected elsewhere");
        return;
      }
      // Hidden tabs belong to backgroundKeepAliveTimeout. Leaving them alone
      // also keeps the client's own park/auto-recover path intact.
      if (document.visibilityState !== "visible") return;
      // Only ever pause a healthy socket. In particular never disconnect out of
      // a failed state: that would turn "disconnected" into "initial" and hide
      // the real error from CanvasConnectionStatus.
      if (statusRef.current !== "connected") return;
      const idleFor = Date.now() - lastActivityRef.current;
      if (idleFor < IDLE_PAUSE_MS) return;
      // Something is mid-flight — let it land and retry on the next tick.
      if (syncRef.current === "synchronizing") {
        console.info(`${LOG} idle ${Math.round(idleFor / 1000)}s but still syncing — waiting`);
        return;
      }

      intentRef.current = true;
      setPausedIntent(true);
      console.info(
        `${LOG} pausing — idle ${Math.round(idleFor / 1000)}s; closing the socket to stop billing`,
      );
      room.disconnect();
    }, IDLE_POLL_MS);

    return () => {
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
      // Deliberately NOT reconnecting/disconnecting here: the connection's
      // lifecycle belongs to RoomProvider, which leaves the room on unmount.
    };
  }, [room, resumeWith]);

  return { paused: pausedIntent && status === "initial", resume };
}
