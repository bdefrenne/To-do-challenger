"use client";

/**
 * Realtime infinite-canvas editor (Miro/Figma-style), hand-rolled on CSS
 * transforms + native pointer events, with multiplayer via Liveblocks.
 *
 *   • Pan   — space-drag, middle-drag, or two-finger scroll.
 *   • Zoom  — ⌘/ctrl + wheel, toward the cursor.
 *   • Tools — V select · T text · S section. Place-then-revert-to-select.
 *   • Text  — markdown blocks; '- '/'1. ' lists auto-continue.
 *   • Section — a titled container bound to a real board, showing its tasks.
 *
 * Nodes live in Liveblocks **Storage** (a LiveMap of LiveObjects), so edits
 * merge conflict-free across everyone in the room. Undo/redo uses Liveblocks
 * history. Cursors + selections are **Presence**. The viewport is per-user
 * (localStorage, not shared). A debounced snapshot mirrors storage → Postgres
 * so reloads and the canvas index keep working.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { LiveObject, type Json } from "@liveblocks/client";
import {
  useStorage,
  useMutation,
  useOthers,
  useUpdateMyPresence,
  useHistory,
  useBroadcastEvent,
  useEventListener,
} from "@liveblocks/react";
import type { CanvasNode, CanvasNodeKind } from "@/lib/types";
import type { StoredNode } from "@/liveblocks.config";
import {
  CanvasNode as NodeView,
  NEW_TEXT_SIZE,
  NEW_SECTION_SIZE,
} from "./CanvasNode";
import {
  strokePath,
  DEFAULT_PEN_COLOR,
  DEFAULT_PEN_WIDTH,
} from "./DrawNode";
import { useWorkspace, type TaskEdit } from "./WorkspaceContext";

type Tool = "select" | "text" | "section" | "draw" | "erase";

/** Pen palette + widths offered when the pencil is active. */
const PEN_COLORS = ["#111827", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7"];
const PEN_WIDTHS = [2, 4, 8];

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const uid = () => crypto.randomUUID();

/** The task ids a text note links to (drawn as connectors to their cards). */
const linkedIdsOf = (n: { data?: Record<string, unknown> }): string[] =>
  (n.data?.linkedTaskIds as string[] | undefined) ?? [];

/** The point on `rect`'s border along the ray from its centre toward (fx,fy) —
 *  so a connector meets a box at its edge instead of crossing into it. */
function borderPoint(
  fx: number,
  fy: number,
  rect: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = fx - cx;
  const dy = fy - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? rect.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? rect.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** The persisted signature of a node — used to diff storage vs Postgres.
 *  Accepts any node-shaped object (mutable CanvasNode or readonly storage node). */
const sig = (n: {
  kind: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string | null;
  position: number;
  data?: unknown;
}) =>
  JSON.stringify([
    n.kind,
    n.content,
    Math.round(n.x),
    Math.round(n.y),
    Math.round(n.width),
    // A section sizes to its content (height:auto), so its mirrored height is
    // derived, not authored — excluded here so a pure height change (e.g. an
    // Outline↔Cards toggle) never schedules a Postgres write. The live height
    // still rides in Liveblocks storage for selection bounds and is re-derived
    // from content on load. Other kinds keep their user-set height.
    n.kind === "section" ? 0 : Math.round(n.height),
    n.color ?? null,
    n.position,
    n.data ?? {},
  ]);

const loadViewport = (canvasId: string): Viewport => {
  try {
    const raw = localStorage.getItem(`canvas-vp:${canvasId}`);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { x: 0, y: 0, scale: 1 };
};

interface Pen {
  color: string;
  width: number;
}

const loadPen = (canvasId: string): Pen => {
  try {
    const raw = localStorage.getItem(`canvas-pen:${canvasId}`);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.color === "string" && typeof p?.width === "number") return p;
    }
  } catch {
    /* ignore */
  }
  return { color: DEFAULT_PEN_COLOR, width: DEFAULT_PEN_WIDTH };
};

export function CanvasEditor({
  canvasId,
  canvasName,
}: {
  canvasId: string;
  canvasName: string;
}) {
  const nodesMap = useStorage((root) => root.nodes);
  const others = useOthers();
  const updateMyPresence = useUpdateMyPresence();
  const history = useHistory();
  const broadcast = useBroadcastEvent();
  const { subscribeLocalChange, refreshFromRemote, applyRemotePatch } = useWorkspace();

  // useStorage's root is ToJson<Storage>, so `nodes` is a plain readonly
  // record (id → node), not a Map — hence Object.values, not .values().
  const nodes: CanvasNode[] = useMemo(
    () => (nodesMap ? Object.values(nodesMap).map((n) => ({ ...n })) : []),
    [nodesMap],
  );

  // This editor only mounts client-side (after the canvas fetch resolves), so
  // reading localStorage in the initializer is safe — no SSR/hydration mismatch.
  const [viewport, setViewport] = useState<Viewport>(() => loadViewport(canvasId));
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  // Nodes YOU are actively dragging — excluded from smoothing so they track
  // the cursor 1:1 (everyone else sees them glide via the node transition).
  const [draggingIds, setDraggingIds] = useState<Set<string>>(new Set());

  // Freehand pen. `pen` is the current ink (persisted per-user); `drawing` is
  // the in-flight stroke — a flat [x,y,…] list in canvas coords, shown as a live
  // preview until pointerup commits it to a `draw` node.
  const [pen, setPen] = useState<Pen>(() => loadPen(canvasId));
  const [drawing, setDrawing] = useState<number[] | null>(null);

  // Note→task links. `linkDrag` is the in-flight connection (dragging a text
  // note's port toward a task card); `linkLines` are the committed connectors,
  // re-measured each frame from the task cards' live DOM positions.
  const [linkDrag, setLinkDrag] = useState<{
    fromId: string;
    fromX: number;
    fromY: number;
    x: number;
    y: number;
    overTaskId: string | null;
  } | null>(null);
  const [linkLines, setLinkLines] = useState<
    { key: string; fromId: string; taskId: string; x1: number; y1: number; x2: number; y2: number }[]
  >([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const vpRef = useRef(viewport);
  const spaceRef = useRef(false);
  const toolRef = useRef(tool);
  const selectedRef = useRef(selected);
  const editingRef = useRef(editingId);
  const penRef = useRef(pen);
  useEffect(() => void (nodesRef.current = nodes), [nodes]);
  useEffect(() => void (vpRef.current = viewport), [viewport]);
  useEffect(() => void (toolRef.current = tool), [tool]);
  useEffect(() => void (selectedRef.current = selected), [selected]);
  useEffect(() => void (editingRef.current = editingId), [editingId]);
  useEffect(() => void (penRef.current = pen), [pen]);

  // Persist this user's own viewport (per-user, not shared with the room).
  useEffect(() => {
    try {
      localStorage.setItem(`canvas-vp:${canvasId}`, JSON.stringify(viewport));
    } catch {
      /* ignore */
    }
  }, [viewport, canvasId]);

  // Persist the chosen pen (per-user, like the viewport).
  useEffect(() => {
    try {
      localStorage.setItem(`canvas-pen:${canvasId}`, JSON.stringify(pen));
    } catch {
      /* ignore */
    }
  }, [pen, canvasId]);

  // Broadcast our selection so others see what we've grabbed.
  useEffect(() => {
    updateMyPresence({ selection: [...selected] });
  }, [selected, updateMyPresence]);

  // Realtime task-data bridge (hot path). Task content lives in Postgres, not
  // Liveblocks storage, so a local edit here would otherwise reach peers only
  // via their ≤2s version poll. Instead: when THIS client mutates task data,
  // ping the room; when a peer pings, refresh our task data immediately.
  useEffect(
    () =>
      subscribeLocalChange((signal) => {
        if (signal.kind === "patch")
          broadcast({
            type: "task-patch",
            taskId: signal.taskId,
            patch: signal.patch as Record<string, Json>,
          });
        else broadcast({ type: "tasks-changed" });
      }),
    [subscribeLocalChange, broadcast],
  );
  useEventListener(({ event }) => {
    if (event.type === "task-patch") applyRemotePatch(event.taskId, event.patch as TaskEdit);
    else if (event.type === "tasks-changed") refreshFromRemote();
  });

  /* -------- Liveblocks storage mutations -------- */
  const putNode = useMutation(({ storage }, node: StoredNode) => {
    storage.get("nodes").set(node.id, new LiveObject(node));
  }, []);
  const patchMany = useMutation(
    ({ storage }, updates: { id: string; patch: Partial<StoredNode> }[]) => {
      const map = storage.get("nodes");
      for (const u of updates) {
        const n = map.get(u.id);
        if (n) n.update(u.patch);
      }
    },
    [],
  );
  const removeMany = useMutation(({ storage }, ids: string[]) => {
    const map = storage.get("nodes");
    for (const id of ids) map.delete(id);
  }, []);

  /* -------- snapshot storage → Postgres (debounced diff) -------- */
  const savedRef = useRef<Map<string, string>>(new Map());
  const seededRef = useRef(false);
  const savingRef = useRef(false);
  const againRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (savingRef.current) {
      againRef.current = true;
      return;
    }
    savingRef.current = true;
    try {
      do {
        againRef.current = false;
        const sent = nodesRef.current;
        const upserts = sent.filter((n) => savedRef.current.get(n.id) !== sig(n));
        const ids = new Set(sent.map((n) => n.id));
        const deletes = [...savedRef.current.keys()].filter((id) => !ids.has(id));
        if (!upserts.length && !deletes.length) break;
        try {
          const res = await fetch(`/api/canvases/${canvasId}/nodes`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ upserts, deletes }),
          });
          if (res.ok) {
            for (const n of upserts) savedRef.current.set(n.id, sig(n));
            for (const id of deletes) savedRef.current.delete(id);
          } else break;
        } catch {
          break;
        }
      } while (againRef.current);
    } finally {
      savingRef.current = false;
    }
  }, [canvasId]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 800);
  }, [flush]);

  // Seed the "saved" baseline from the first storage snapshot (it already came
  // FROM Postgres via initialStorage), then snapshot on every later change.
  useEffect(() => {
    if (!nodesMap) return;
    if (!seededRef.current) {
      seededRef.current = true;
      savedRef.current = new Map(Object.values(nodesMap).map((n) => [n.id, sig(n)]));
      return;
    }
    scheduleSave();
  }, [nodesMap, scheduleSave]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void flush();
    };
  }, [flush]);

  /* -------- coordinate transform -------- */
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const vp = vpRef.current;
    return {
      x: (clientX - rect.left - vp.x) / vp.scale,
      y: (clientY - rect.top - vp.y) / vp.scale,
    };
  }, []);

  /* -------- node actions -------- */
  const createNode = useCallback(
    (kind: CanvasNodeKind, x: number, y: number) => {
      const size = kind === "section" ? NEW_SECTION_SIZE : NEW_TEXT_SIZE;
      const maxPos = nodesRef.current.reduce((m, n) => Math.max(m, n.position), 0);
      const node: StoredNode = {
        id: uid(),
        kind,
        content: "",
        x: Math.round(x),
        y: Math.round(y),
        width: size.width,
        height: size.height,
        color: null,
        position: maxPos + 1,
        data: {},
      };
      putNode(node);
      setTool("select");
      setSelected(new Set([node.id]));
      if (kind === "text") setEditingId(node.id);
    },
    [putNode],
  );

  /** Commit an in-flight freehand stroke as a `draw` node. `pts` is a flat
   *  [x,y,…] list in CANVAS coords; we derive the bbox, store the points
   *  relative to it (so dragging only moves x/y), and stamp the current pen.
   *  Stays in the draw tool afterward so you can keep sketching (Figma-like). */
  const createDrawNode = useCallback(
    (pts: number[]) => {
      const count = pts.length >> 1;
      if (count === 0) return;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (let i = 0; i < count; i++) {
        const x = pts[i * 2];
        const y = pts[i * 2 + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const { color, width } = penRef.current;
      const pad = width / 2 + 1; // keep the round line cap inside the bbox
      const originX = Math.round(minX - pad);
      const originY = Math.round(minY - pad);
      const rel = new Array<number>(pts.length);
      for (let i = 0; i < count; i++) {
        rel[i * 2] = Math.round((pts[i * 2] - originX) * 100) / 100;
        rel[i * 2 + 1] = Math.round((pts[i * 2 + 1] - originY) * 100) / 100;
      }
      const maxPos = nodesRef.current.reduce((m, nd) => Math.max(m, nd.position), 0);
      const node: StoredNode = {
        id: uid(),
        kind: "draw",
        content: "",
        x: originX,
        y: originY,
        width: Math.round(maxX + pad - originX),
        height: Math.round(maxY + pad - originY),
        color,
        position: maxPos + 1,
        data: { points: rel, strokeWidth: width },
      };
      putNode(node);
    },
    [putNode],
  );

  const deleteSelected = useCallback(() => {
    const ids = [...selectedRef.current];
    if (!ids.length) return;
    removeMany(ids);
    setSelected(new Set());
    setEditingId(null);
  }, [removeMany]);

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const sel = selectedRef.current;
      if (!sel.size) return;
      patchMany(
        nodesRef.current
          .filter((n) => sel.has(n.id))
          .map((n) => ({ id: n.id, patch: { x: n.x + dx, y: n.y + dy } })),
      );
    },
    [patchMany],
  );

  /* -------- note→task links -------- */
  const patchLinkedIds = useCallback(
    (fromId: string, next: string[]) => {
      const node = nodesRef.current.find((n) => n.id === fromId);
      if (!node) return;
      patchMany([
        {
          id: fromId,
          patch: {
            data: { ...(node.data ?? {}), linkedTaskIds: next } as StoredNode["data"],
          },
        },
      ]);
    },
    [patchMany],
  );

  const addLink = useCallback(
    (fromId: string, taskId: string) => {
      const node = nodesRef.current.find((n) => n.id === fromId);
      if (!node) return;
      const cur = linkedIdsOf(node);
      if (cur.includes(taskId)) return;
      patchLinkedIds(fromId, [...cur, taskId]);
    },
    [patchLinkedIds],
  );

  const removeLink = useCallback(
    (fromId: string, taskId: string) => {
      const node = nodesRef.current.find((n) => n.id === fromId);
      if (!node) return;
      patchLinkedIds(
        fromId,
        linkedIdsOf(node).filter((id) => id !== taskId),
      );
    },
    [patchLinkedIds],
  );

  /** Centre of a task-card element in CANVAS coords — measured relative to the
   *  transformed inner div, so it's independent of pan (scale divides out). */
  const cardCenterCanvas = useCallback((el: HTMLElement) => {
    const inner = innerRef.current;
    if (!inner) return null;
    const ir = inner.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const scale = vpRef.current.scale || 1;
    return {
      x: (r.left + r.width / 2 - ir.left) / scale,
      y: (r.top + r.height / 2 - ir.top) / scale,
    };
  }, []);

  // Drag a text note's port onto a task card to connect them: rubber-band a line
  // to the cursor; over a task card, snap to it and (on release) store the link.
  const startLink = useCallback(
    (e: ReactPointerEvent, node: CanvasNode) => {
      if (e.button !== 0) return;
      const fromX = node.x + node.width;
      const fromY = node.y + node.height / 2;
      setLinkDrag({ fromId: node.id, fromX, fromY, x: fromX, y: fromY, overTaskId: null });

      const taskUnder = (cx: number, cy: number) =>
        (document.elementFromPoint(cx, cy) as HTMLElement | null)?.closest(
          "[data-task-id]",
        ) as HTMLElement | null;

      const onMove = (ev: PointerEvent) => {
        const card = taskUnder(ev.clientX, ev.clientY);
        if (card && card.getAttribute("data-task-id") !== node.id) {
          const c = cardCenterCanvas(card);
          const id = card.getAttribute("data-task-id");
          setLinkDrag((d) => (d ? { ...d, x: c?.x ?? d.x, y: c?.y ?? d.y, overTaskId: id } : d));
        } else {
          const p = toCanvas(ev.clientX, ev.clientY);
          setLinkDrag((d) => (d ? { ...d, x: p.x, y: p.y, overTaskId: null } : d));
        }
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const id = taskUnder(ev.clientX, ev.clientY)?.getAttribute("data-task-id");
        if (id) addLink(node.id, id);
        setLinkDrag(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [toCanvas, cardCenterCanvas, addLink],
  );

  // Keep committed connectors glued to their task cards. Card positions live in
  // the DOM (inside sections), not in `nodes`, so re-measure on an animation
  // frame whenever a link exists or a drag is in flight — cheap DOM reads, and
  // we only re-render when the geometry actually changes.
  useEffect(() => {
    const anyLinks = nodes.some((n) => n.kind === "text" && linkedIdsOf(n).length > 0);
    if (!anyLinks && !linkDrag) {
      // Nothing to track — clear any stale lines on the next frame (deferred so
      // this isn't a synchronous setState in the effect body).
      const raf = requestAnimationFrame(() =>
        setLinkLines((prev) => (prev.length ? [] : prev)),
      );
      return () => cancelAnimationFrame(raf);
    }
    let raf = 0;
    let prevKey = "";
    const measure = () => {
      const inner = innerRef.current;
      if (inner) {
        const ir = inner.getBoundingClientRect();
        const scale = vpRef.current.scale || 1;
        const out: typeof linkLines = [];
        for (const node of nodesRef.current) {
          if (node.kind !== "text") continue;
          const ids = linkedIdsOf(node);
          if (!ids.length) continue;
          const noteRect = { x: node.x, y: node.y, w: node.width, h: node.height };
          const noteCx = node.x + node.width / 2;
          const noteCy = node.y + node.height / 2;
          for (const taskId of ids) {
            const el = inner.querySelector(
              `[data-task-id="${CSS.escape(taskId)}"]`,
            ) as HTMLElement | null;
            if (!el) continue; // linked task isn't on this canvas — skip its line
            const r = el.getBoundingClientRect();
            const taskRect = {
              x: (r.left - ir.left) / scale,
              y: (r.top - ir.top) / scale,
              w: r.width / scale,
              h: r.height / scale,
            };
            const tCx = taskRect.x + taskRect.w / 2;
            const tCy = taskRect.y + taskRect.h / 2;
            const a = borderPoint(tCx, tCy, noteRect); // exit note toward task
            const b = borderPoint(noteCx, noteCy, taskRect); // enter task from note
            out.push({
              key: `${node.id}->${taskId}`,
              fromId: node.id,
              taskId,
              x1: a.x,
              y1: a.y,
              x2: b.x,
              y2: b.y,
            });
          }
        }
        const key = JSON.stringify(out);
        if (key !== prevKey) {
          prevKey = key;
          setLinkLines(out);
        }
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [nodes, linkDrag]);

  /* -------- zoom -------- */
  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    setViewport((vp) => {
      const rect = containerRef.current!.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vp.scale * factor));
      const k = next / vp.scale;
      return { scale: next, x: mx - (mx - vp.x) * k, y: my - (my - vp.y) * k };
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else {
        setViewport((vp) => ({ ...vp, x: vp.x - e.deltaX, y: vp.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /* -------- keyboard -------- */
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement;
      return (
        editingRef.current !== null ||
        (el instanceof HTMLElement &&
          (el.tagName === "TEXTAREA" || el.tagName === "INPUT"))
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        if (isTyping()) return;
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (isTyping()) return;
      switch (e.key) {
        case "t":
        case "T":
          setTool("text");
          break;
        case "s":
        case "S":
          setTool("section");
          break;
        case "p":
        case "P":
          setTool("draw");
          break;
        case "e":
        case "E":
          setTool("erase");
          break;
        case "v":
        case "V":
          setTool("select");
          break;
        case "Escape":
          setTool("select");
          setSelected(new Set());
          setEditingId(null);
          break;
        case "Backspace":
        case "Delete":
          e.preventDefault();
          deleteSelected();
          break;
        case " ":
          spaceRef.current = true;
          setSpaceDown(true);
          e.preventDefault();
          break;
        case "ArrowUp":
          e.preventDefault();
          nudge(0, e.shiftKey ? -10 : -1);
          break;
        case "ArrowDown":
          e.preventDefault();
          nudge(0, e.shiftKey ? 10 : 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          nudge(e.shiftKey ? -10 : -1, 0);
          break;
        case "ArrowRight":
          e.preventDefault();
          nudge(e.shiftKey ? 10 : 1, 0);
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") {
        spaceRef.current = false;
        setSpaceDown(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [history, deleteSelected, nudge]);

  /* -------- pointer: nodes (select + drag) -------- */
  const onNodePointerDown = useCallback(
    (e: ReactPointerEvent, node: CanvasNode) => {
      if (e.button !== 0 || spaceRef.current) return;
      e.stopPropagation();
      if (editingRef.current === node.id) return;

      let sel = new Set(selectedRef.current);
      if (e.shiftKey) {
        if (sel.has(node.id)) sel.delete(node.id);
        else sel.add(node.id);
      } else if (!sel.has(node.id)) {
        sel = new Set([node.id]);
      }
      setSelected(sel);
      setEditingId(null);

      const scale = vpRef.current.scale;
      const origin = new Map(
        nodesRef.current
          .filter((n) => sel.has(n.id))
          .map((n) => [n.id, { x: n.x, y: n.y }] as const),
      );
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) {
          moved = true;
          history.pause(); // group the whole drag into one undo step
          setDraggingIds(new Set(origin.keys())); // skip smoothing on these
        }
        if (!moved) return;
        patchMany(
          [...origin.entries()].map(([id, o]) => ({
            id,
            patch: { x: Math.round(o.x + dx), y: Math.round(o.y + dy) },
          })),
        );
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (moved) {
          history.resume();
          setDraggingIds(new Set());
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [patchMany, history],
  );

  /* -------- pointer: background (pan / create / marquee) -------- */
  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button === 1 || spaceRef.current) {
        const startX = e.clientX;
        const startY = e.clientY;
        const { x: vx, y: vy } = vpRef.current;
        const onMove = (ev: PointerEvent) =>
          setViewport((vp) => ({ ...vp, x: vx + (ev.clientX - startX), y: vy + (ev.clientY - startY) }));
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return;
      }
      if (e.button !== 0) return;

      if (toolRef.current === "text" || toolRef.current === "section") {
        e.preventDefault();
        const p = toCanvas(e.clientX, e.clientY);
        createNode(toolRef.current, p.x, p.y);
        return;
      }

      // Freehand pen: sample the cursor path, preview it live, commit on release.
      if (toolRef.current === "draw") {
        e.preventDefault();
        const pts: number[] = [];
        const push = (cx: number, cy: number) => {
          const p = toCanvas(cx, cy);
          pts.push(p.x, p.y);
        };
        push(e.clientX, e.clientY);
        setDrawing(pts.slice());
        const onMove = (ev: PointerEvent) => {
          // Coalesced events recover the sub-frame samples the browser batched,
          // so fast strokes stay smooth.
          const batch = ev.getCoalescedEvents?.() ?? [];
          if (batch.length) for (const c of batch) push(c.clientX, c.clientY);
          else push(ev.clientX, ev.clientY);
          setDrawing(pts.slice());
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          setDrawing(null);
          createDrawNode(pts);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return;
      }

      // Eraser: drag across strokes to delete them (whole-stroke). Hit-tests the
      // ink via the draw node's transparent hit-path, like the link drag above.
      if (toolRef.current === "erase") {
        e.preventDefault();
        const eraseAt = (cx: number, cy: number) => {
          const id = (document.elementFromPoint(cx, cy) as HTMLElement | null)
            ?.closest("[data-draw-id]")
            ?.getAttribute("data-draw-id");
          if (id) removeMany([id]);
        };
        eraseAt(e.clientX, e.clientY);
        const onMove = (ev: PointerEvent) => eraseAt(ev.clientX, ev.clientY);
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return;
      }

      const start = toCanvas(e.clientX, e.clientY);
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        const cur = toCanvas(ev.clientX, ev.clientY);
        moved = true;
        const rect = {
          x0: Math.min(start.x, cur.x),
          y0: Math.min(start.y, cur.y),
          x1: Math.max(start.x, cur.x),
          y1: Math.max(start.y, cur.y),
        };
        setMarquee(rect);
        const hit = nodesRef.current
          .filter(
            (n) =>
              n.x < rect.x1 && n.x + n.width > rect.x0 && n.y < rect.y1 && n.y + n.height > rect.y0,
          )
          .map((n) => n.id);
        setSelected(new Set(hit));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setMarquee(null);
        if (!moved) {
          setSelected(new Set());
          setEditingId(null);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [toCanvas, createNode, createDrawNode, removeMany],
  );

  /* -------- live cursor broadcast -------- */
  const onContainerPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const p = toCanvas(e.clientX, e.clientY);
      updateMyPresence({ cursor: { x: Math.round(p.x), y: Math.round(p.y) } });
    },
    [toCanvas, updateMyPresence],
  );
  const onContainerPointerLeave = useCallback(() => {
    updateMyPresence({ cursor: null });
  }, [updateMyPresence]);

  // Which nodes are selected by OTHERS (id → their colour), for remote rings.
  const remoteSelection = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of others) {
      const color = o.info?.color ?? "#7b68ee";
      for (const id of o.presence.selection ?? []) if (!m.has(id)) m.set(id, color);
    }
    return m;
  }, [others]);

  // Frames render behind everything (they're backdrops); text + sections layer
  // by z-order among themselves.
  const ordered = [...nodes].sort((a, b) => a.position - b.position);

  // The master section per DB board: a section whose `data.master` is set. Its
  // Send buttons on sibling sections (same board) target it. `content` is the
  // section's title. One master per board is enforced when marking one (below).
  const masterByBoard = new Map<string, { id: string; name: string }>();
  for (const n of nodes) {
    const bid = n.data?.boardId as string | undefined;
    if (n.kind === "section" && bid && n.data?.master === true) {
      masterByBoard.set(bid, { id: n.id, name: n.content });
    }
  }

  const cursor = spaceDown
    ? "grab"
    : tool === "text" || tool === "section" || tool === "draw"
      ? "crosshair"
      : tool === "erase"
        ? "cell"
        : "default";

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Toolbar */}
      <div className="absolute left-3 top-3 z-20 flex flex-col items-start gap-1">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-sm">
          <ToolBtn active={tool === "select"} onClick={() => setTool("select")} title="Select (V)">⌖</ToolBtn>
          <ToolBtn active={tool === "text"} onClick={() => setTool("text")} title="Text (T)">T</ToolBtn>
          <ToolBtn active={tool === "section"} onClick={() => setTool("section")} title="Section — outline of tasks (S)">▤</ToolBtn>
          <ToolBtn active={tool === "draw"} onClick={() => setTool("draw")} title="Draw — freehand pen (P)">✏️</ToolBtn>
          <ToolBtn active={tool === "erase"} onClick={() => setTool("erase")} title="Erase strokes (E)">⌫</ToolBtn>
        </div>

        {/* Pen controls — colour + width, shown only while the pencil is active. */}
        {tool === "draw" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 shadow-sm">
            <div className="flex items-center gap-1">
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPen((p) => ({ ...p, color: c }))}
                  title={`Ink ${c}`}
                  aria-label={`Ink ${c}`}
                  className={[
                    "h-5 w-5 rounded-full border transition-transform",
                    pen.color === c
                      ? "scale-110 border-accent ring-2 ring-accent"
                      : "border-border hover:scale-110",
                  ].join(" ")}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-1">
              {PEN_WIDTHS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setPen((p) => ({ ...p, width: w }))}
                  title={`${w}px`}
                  aria-label={`Stroke width ${w}px`}
                  className={[
                    "grid h-6 w-6 place-items-center rounded-md transition-colors",
                    pen.width === w ? "bg-accent-soft" : "hover:bg-surface-2",
                  ].join(" ")}
                >
                  <span
                    className="rounded-full bg-fg"
                    style={{ width: w + 2, height: w + 2 }}
                  />
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Presence: who's here */}
      <div className="absolute right-3 top-3 z-20 flex items-center -space-x-1.5">
        {others.slice(0, 6).map((o) => (
          <span
            key={o.connectionId}
            title={o.info?.name ?? "Someone"}
            className="grid h-7 w-7 place-items-center rounded-full border-2 border-surface text-[11px] font-semibold text-white shadow-sm"
            style={{ backgroundColor: o.info?.color ?? "#7b68ee" }}
          >
            {(o.info?.name ?? "?").slice(0, 1).toUpperCase()}
          </span>
        ))}
      </div>

      <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-md bg-surface/80 px-2 py-1 text-[11px] text-faint shadow-sm backdrop-blur">
        {tool === "text"
          ? "Click to drop a text block"
          : tool === "section"
            ? "Click to drop a board — name it, then outline your tasks"
            : tool === "draw"
              ? "Drag to draw · pick colour & width on the left"
              : tool === "erase"
                ? "Drag across a stroke to erase it"
                : "T text · B board · P draw · E erase · space-drag to pan · ⌘-scroll to zoom"}
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-surface p-1 text-sm shadow-sm">
        <ToolBtn onClick={() => zoomAtCenter(0.8)} title="Zoom out">−</ToolBtn>
        <button
          onClick={() => setViewport((v) => ({ ...v, scale: 1 }))}
          className="min-w-[3rem] rounded px-2 py-1 text-center text-xs text-muted hover:bg-surface-2"
          title="Reset zoom"
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <ToolBtn onClick={() => zoomAtCenter(1.25)} title="Zoom in">+</ToolBtn>
      </div>

      {/* Canvas surface */}
      <div
        ref={containerRef}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onContainerPointerMove}
        onPointerLeave={onContainerPointerLeave}
        className="absolute inset-0 touch-none select-none"
        style={{
          cursor,
          backgroundImage: "radial-gradient(circle, var(--color-border-strong) 1px, transparent 1px)",
          backgroundSize: `${24 * viewport.scale}px ${24 * viewport.scale}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        }}
      >
        <div
          ref={innerRef}
          className="absolute left-0 top-0"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
            transformOrigin: "0 0",
          }}
        >
          {ordered.map((node) => (
            <NodeView
              key={node.id}
              node={node}
              selected={selected.has(node.id)}
              editing={editingId === node.id}
              smooth={!draggingIds.has(node.id)}
              onPointerDown={(e) => onNodePointerDown(e, node)}
              onStartEditing={() => {
                setSelected(new Set([node.id]));
                setEditingId(node.id);
              }}
              onChange={(content) => patchMany([{ id: node.id, patch: { content } }])}
              onResize={(height) => patchMany([{ id: node.id, patch: { height } }])}
              onStopEditing={() => setEditingId(null)}
              onPatch={(patch) =>
                patchMany([{ id: node.id, patch: patch as Partial<StoredNode> }])
              }
              isMaster={node.data?.master === true}
              masterSection={(() => {
                const bid = node.data?.boardId as string | undefined;
                if (!bid) return null;
                const m = masterByBoard.get(bid);
                return m && m.id !== node.id ? m : null;
              })()}
              onSetMaster={(v) => {
                const bid = node.data?.boardId as string | undefined;
                const updates: { id: string; patch: Partial<StoredNode> }[] = [
                  { id: node.id, patch: { data: { ...node.data, master: v } } },
                ];
                // One master per board: marking this one demotes any sibling.
                if (v && bid) {
                  for (const other of nodes) {
                    if (
                      other.id !== node.id &&
                      other.kind === "section" &&
                      other.data?.boardId === bid &&
                      other.data?.master === true
                    ) {
                      updates.push({
                        id: other.id,
                        patch: { data: { ...other.data, master: false } },
                      });
                    }
                  }
                }
                patchMany(updates);
              }}
              onRemove={() => {
                removeMany([node.id]);
                setSelected((s) => {
                  const next = new Set(s);
                  next.delete(node.id);
                  return next;
                });
              }}
              onLinkStart={
                node.kind === "text" ? (e) => startLink(e, node) : undefined
              }
              canvasName={canvasName}
            />
          ))}

          {/* Note→task connectors + the in-flight drag line. Above the nodes so
              arrowheads stay visible; endpoints sit on the boxes' borders so the
              stroke lives in the gap, not across the cards. */}
          <svg
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            style={{ width: 1, height: 1 }}
          >
            <defs>
              <marker
                id="link-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" fill="var(--color-accent)" />
              </marker>
            </defs>
            {linkLines.map((l) => (
              <g key={l.key}>
                <line
                  x1={l.x1}
                  y1={l.y1}
                  x2={l.x2}
                  y2={l.y2}
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  markerEnd="url(#link-arrow)"
                />
                {/* Fat transparent hit line — click to unlink. */}
                <line
                  x1={l.x1}
                  y1={l.y1}
                  x2={l.x2}
                  y2={l.y2}
                  stroke="transparent"
                  strokeWidth={14}
                  className="pointer-events-auto cursor-pointer"
                  onClick={() => removeLink(l.fromId, l.taskId)}
                >
                  <title>Click to unlink</title>
                </line>
              </g>
            ))}
            {linkDrag ? (
              <line
                x1={linkDrag.fromX}
                y1={linkDrag.fromY}
                x2={linkDrag.x}
                y2={linkDrag.y}
                stroke="var(--color-accent)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray="6 5"
                opacity={linkDrag.overTaskId ? 1 : 0.6}
                markerEnd="url(#link-arrow)"
              />
            ) : null}
          </svg>

          {/* Live freehand stroke — the in-flight pen line, before pointerup
              commits it to a `draw` node. Coords are canvas-space (this sits in
              the transformed inner div), so no conversion is needed. */}
          {drawing ? (
            <svg
              className="pointer-events-none absolute left-0 top-0 overflow-visible"
              style={{ width: 1, height: 1 }}
            >
              {drawing.length >= 4 ? (
                <path
                  d={strokePath(drawing)}
                  fill="none"
                  stroke={pen.color}
                  strokeWidth={pen.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <circle cx={drawing[0]} cy={drawing[1]} r={pen.width / 2} fill={pen.color} />
              )}
            </svg>
          ) : null}

          {/* Remote selection rings */}
          {ordered.map((node) => {
            const color = remoteSelection.get(node.id);
            if (!color) return null;
            return (
              <div
                key={`rs-${node.id}`}
                className="pointer-events-none absolute rounded-lg"
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                  outline: `2px solid ${color}`,
                  outlineOffset: 2,
                  // Glide the ring's box too, so it stays glued to a remote
                  // node whose height changes as its text reflows.
                  transition:
                    "left 90ms linear, top 90ms linear, width 90ms linear, height 90ms linear",
                }}
              />
            );
          })}

          {/* Remote cursors */}
          {others.map((o) =>
            o.presence.cursor ? (
              <div
                key={`c-${o.connectionId}`}
                className="pointer-events-none absolute left-0 top-0 z-30"
                style={{
                  transform: `translate(${o.presence.cursor.x}px, ${o.presence.cursor.y}px)`,
                  // Glide between the ~100ms-throttled presence updates.
                  transition: "transform 110ms linear",
                }}
              >
                <div style={{ transform: `scale(${1 / viewport.scale})`, transformOrigin: "0 0" }}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M1 1l5 13 2.2-5.3L13.5 6 1 1z"
                      fill={o.info?.color ?? "#7b68ee"}
                      stroke="white"
                      strokeWidth="1"
                    />
                  </svg>
                  <span
                    className="ml-3 -mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm"
                    style={{ backgroundColor: o.info?.color ?? "#7b68ee" }}
                  >
                    {o.info?.name ?? "Someone"}
                  </span>
                </div>
              </div>
            ) : null,
          )}

          {marquee ? (
            <div
              className="absolute border border-accent bg-accent/10"
              style={{
                left: marquee.x0,
                top: marquee.y0,
                width: marquee.x1 - marquee.x0,
                height: marquee.y1 - marquee.y0,
              }}
            />
          ) : null}
        </div>
      </div>

      {/* Connecting / empty states */}
      {!nodesMap ? (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <p className="text-sm text-faint">Connecting to the board…</p>
        </div>
      ) : nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <p className="text-sm text-faint">
            Press <kbd className="rounded bg-surface-3 px-1">T</kbd> for text,{" "}
            <kbd className="rounded bg-surface-3 px-1">S</kbd> for a section of tasks, or{" "}
            <kbd className="rounded bg-surface-3 px-1">P</kbd> to draw — then use the canvas.
          </p>
        </div>
      ) : null}
    </div>
  );

  function zoomAtCenter(factor: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }
}

function ToolBtn({
  children,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={[
        "grid h-8 w-8 place-items-center rounded-md text-sm transition-colors",
        active ? "bg-accent-soft font-semibold text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
