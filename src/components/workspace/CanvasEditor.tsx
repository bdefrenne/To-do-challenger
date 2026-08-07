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
  useSelf,
  useUpdateMyPresence,
  useHistory,
  useBroadcastEvent,
  useEventListener,
  useStatus,
} from "@liveblocks/react";
import type { CanvasNode, CanvasNodeKind } from "@/lib/types";
import type { StoredNode } from "@/liveblocks.config";
import {
  NEW_TEXT_SIZE,
  NEW_SECTION_SIZE,
  NEW_GROUP_SIZE,
} from "./CanvasNode";
import { CanvasNodeHost, type NodeApi } from "./CanvasNodeHost";
import {
  GROUP_HEADER_H,
  GROUP_PAD,
  GROUP_GAP,
  groupLayoutOf,
  type GroupLayout,
} from "./SectionGroupNode";
import {
  strokePath,
  DEFAULT_PEN_COLOR,
  DEFAULT_PEN_WIDTH,
} from "./DrawNode";
import { uploadCanvasImage } from "./uploadCanvasImage";
import { CanvasStickyNote, STICKY_WIDTH } from "./CanvasStickyNote";
import { useWorkspace, type TaskEdit } from "./WorkspaceContext";
import { MIN_SECTION_HEIGHT } from "./SectionNode";
import { SectionMembershipProvider } from "./SectionMembershipContext";
import {
  anchorTrioGroupIds,
  boardsFiledInSystemGroup,
  boardsNeedingInbox,
  boardsNeedingWeekLane,
  buildSectionMembership,
  isInboxNode,
  isThisWeekGroup,
  laneBoardId,
  masterSectionsByBoard,
  systemGroupId,
  systemGroupOf,
  systemLaneId,
  thisWeekGroupId,
  weekLaneId,
  SYSTEM_GROUPS,
  SYSTEM_GROUP_TITLE,
  type SystemGroup,
} from "@/lib/sections";
import type { TaskPlacement } from "@/lib/types";

type Tool = "select" | "text" | "section" | "group" | "draw" | "erase" | "sticky";

/** Pen palette + widths offered when the pencil is active. */
const PEN_COLORS = ["#111827", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff"];
const PEN_WIDTHS = [2, 4, 8];

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
/** How long it takes to glide onto a peer's view. Long enough to read as travel
 *  (so you keep your bearings), short enough not to feel like waiting. */
const JUMP_MS = 320;
/** Longest edge (canvas units) a freshly pasted/dropped image is scaled to. */
const MAX_PLACE = 480;
/** Vertical gap between THIS WEEK and BACKLOG, and between BACKLOG and LATER,
 *  when they're first anchored into a stack (see the "Anchor BACKLOG/LATER"
 *  effect). Matches the tray-column gap the system-group reconciler already
 *  uses (`NEW_GROUP_SIZE.height + 120`). */
const TRIO_GAP = 120;
const uid = () => crypto.randomUUID();

/** The task ids a text note links to (drawn as connectors to their cards). */
/** A drawn note→task connector, in canvas coords. */
interface LinkLine {
  key: string;
  fromId: string;
  taskId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

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

/* ===================== Section-group layout =====================
 * A `section_group` is a movable container; its member sections (each tagged
 * `data.groupId === group.id`) are packed either down a column (portrait) or
 * across a row (landscape, per `group.data.layout`) and its box auto-fits them.
 * Membership + order (the fractional `position` key) are the source of truth;
 * each member's x/y and the group's width/height are DERIVED here and mirrored
 * into storage, mirroring how a section mirrors its measured height. */

/** A group's member sections in packing order (fractional `position` order) —
 *  top-to-bottom in portrait, left-to-right in landscape. */
const groupMembers = (nodes: CanvasNode[], groupId: string): CanvasNode[] =>
  nodes
    .filter((n) => n.kind === "section" && n.data?.groupId === groupId)
    .sort((a, b) => a.position - b.position);

/** A lane's slot in the INBOX column. Lanes used to all be created with
 *  `position: 0`, which left their order to a tie-break (storage insertion order)
 *  — so it could differ between clients and shuffle on reload. Derived from the
 *  board id instead: arbitrary but STABLE everywhere, with the "No board"
 *  catch-all pinned last. Kept well inside the fractional range the drop math
 *  uses, so a lane can still be re-slotted by hand. */
const lanePosition = (boardId: string | null): number => {
  if (boardId === null) return 1000;
  let h = 0;
  for (let i = 0; i < boardId.length; i++) h = (h * 31 + boardId.charCodeAt(i)) % 997;
  return h;
};

/** How far outside a group's box the drag cursor still counts as "inside" — a
 *  forgiveness band that works both ways: it captures a near-miss drop, and
 *  (since release uses the same test) gives a member free hysteresis so a
 *  jittery pointer can't pop it out. */
const GROUP_CAPTURE_MARGIN = 28;

/** The topmost `section_group` whose box (grown by the capture margin) contains
 *  a canvas point (or null). The point is the drag's GRAB POINT — the cursor —
 *  never the dragged section's centre: a section is `height:auto` and can be
 *  1000+ units tall, so its centre sits far below the group you're aiming at and
 *  tall sections could never be captured at all. */
const groupAtPoint = (
  nodes: CanvasNode[],
  px: number,
  py: number,
): CanvasNode | null => {
  const m = GROUP_CAPTURE_MARGIN;
  let hit: CanvasNode | null = null;
  for (const n of nodes) {
    if (n.kind !== "section_group") continue;
    if (
      px >= n.x - m &&
      px <= n.x + n.width + m &&
      py >= n.y - m &&
      py <= n.y + n.height + m
    ) {
      if (!hit || n.position > hit.position) hit = n;
    }
  }
  return hit;
};

/** Which slot of a group's packing order a drop lands in: the count of members
 *  the drop point has passed, comparing against each member's midline along the
 *  packing axis (the standard list-reorder rule). `c` is the drop CURSOR on that
 *  axis — canvas Y in portrait, canvas X in landscape. `members` excludes the
 *  section being placed and is already in packing order. */
const slotIndexForDrop = (
  members: CanvasNode[],
  c: number,
  layout: GroupLayout,
): number => {
  let index = 0;
  for (const m of members) {
    const mid = layout === "landscape" ? m.x + m.width / 2 : m.y + m.height / 2;
    if (c > mid) index++;
    else break;
  }
  return index;
};

/** A fractional `position` that drops a section into a group at the slot nearest
 *  the drop cursor — midway between the fractional keys of the slot's
 *  neighbours. Args as `slotIndexForDrop`. */
const slotPositionForDrop = (
  members: CanvasNode[],
  c: number,
  layout: GroupLayout,
): number => {
  const index = slotIndexForDrop(members, c, layout);
  const above = members[index - 1];
  const below = members[index];
  const prev = above ? above.position : below ? below.position - 2 : 0;
  const next = below ? below.position : above ? above.position + 2 : 2;
  return (prev + next) / 2;
};

/** The insertion caret for slot `index` of a group: a thin bar in the gap the
 *  section would land in, in CANVAS coords. Drawn above every node because a
 *  group packs its members on top of itself, so the dragged section covers the
 *  group's body (and its drop hint) — the accent ring alone can't say WHERE it
 *  will land. Takes the index (not a cursor) so the live drag can keep only the
 *  index in state and derive this at render — see `dropCaret`. */
const slotCaretRect = (
  group: CanvasNode,
  members: CanvasNode[],
  index: number,
  layout: GroupLayout,
): { x: number; y: number; w: number; h: number } => {
  const prev = members[index - 1];
  const thickness = 3;
  if (layout === "landscape") {
    // Vertical bar in the row: after `prev`'s right edge, else at the inner left.
    return {
      x: (prev ? prev.x + prev.width + GROUP_GAP / 2 : group.x + GROUP_PAD / 2) - thickness / 2,
      y: group.y + GROUP_HEADER_H + GROUP_PAD,
      w: thickness,
      h: Math.max(0, group.height - GROUP_HEADER_H - 2 * GROUP_PAD),
    };
  }
  // Horizontal bar in the column: below `prev`, else just under the header.
  return {
    x: group.x + GROUP_PAD,
    y:
      (prev
        ? prev.y + prev.height + GROUP_GAP / 2
        : group.y + GROUP_HEADER_H + GROUP_PAD / 2) - thickness / 2,
    w: Math.max(0, group.width - 2 * GROUP_PAD),
    h: thickness,
  };
};

/** Compute the derived layout for every group: each member section's x/y slot
 *  (packed down a column in portrait, across a row in landscape) and the group's
 *  auto-fit width/height. Returns only the patches that differ (rounded),
 *  skipping any node currently being dragged (`skip`) so a live drag owns its
 *  own position. */
const computeGroupLayout = (
  nodes: CanvasNode[],
  skip: Set<string>,
): { id: string; patch: Partial<StoredNode> }[] => {
  const patches: { id: string; patch: Partial<StoredNode> }[] = [];
  for (const g of nodes) {
    if (g.kind !== "section_group") continue;
    const members = groupMembers(nodes, g.id);
    if (members.length === 0) {
      // Empty group shrinks back to its default drop-target size.
      if (
        Math.round(g.width) !== NEW_GROUP_SIZE.width ||
        Math.round(g.height) !== NEW_GROUP_SIZE.height
      ) {
        if (!skip.has(g.id))
          patches.push({
            id: g.id,
            patch: { width: NEW_GROUP_SIZE.width, height: NEW_GROUP_SIZE.height },
          });
      }
      continue;
    }
    // Pack along the group's axis: portrait walks a cursor down the column at a
    // fixed inner X; landscape walks it across the row at a fixed inner Y. The
    // cross-axis extent is the widest (resp. tallest) member.
    const landscape = groupLayoutOf(g) === "landscape";
    const innerX = Math.round(g.x + GROUP_PAD);
    const innerY = Math.round(g.y + GROUP_HEADER_H + GROUP_PAD);
    let cursor = landscape ? g.x + GROUP_PAD : g.y + GROUP_HEADER_H + GROUP_PAD;
    let cross = 0;
    for (const m of members) {
      const nx = landscape ? Math.round(cursor) : innerX;
      const ny = landscape ? innerY : Math.round(cursor);
      cross = Math.max(cross, landscape ? m.height : m.width);
      if (!skip.has(m.id) && (Math.round(m.x) !== nx || Math.round(m.y) !== ny)) {
        patches.push({ id: m.id, patch: { x: nx, y: ny } });
      }
      cursor += (landscape ? m.width : m.height) + GROUP_GAP;
    }
    // Wrap the members tightly, closing on the same GROUP_PAD inset the packing
    // opened with. No trailing drop-zone band: a drop is captured by the group's
    // whole box (see `groupAtPoint`), so the band was decoration, and it left the
    // group visibly longer than its contents.
    const desiredW = landscape
      ? Math.round(cursor - GROUP_GAP - g.x + GROUP_PAD)
      : Math.round(cross + 2 * GROUP_PAD);
    const desiredH = landscape
      ? Math.round(GROUP_HEADER_H + cross + 2 * GROUP_PAD)
      : Math.round(cursor - GROUP_GAP - g.y + GROUP_PAD);
    if (
      !skip.has(g.id) &&
      (Math.round(g.width) !== desiredW || Math.round(g.height) !== desiredH)
    ) {
      patches.push({ id: g.id, patch: { width: desiredW, height: desiredH } });
    }
  }
  return patches;
};

/** This user's saved view of `canvasId`, plus whether there WAS one. A canvas
 *  you've never opened has no saved view, and its content is rarely near the
 *  origin — `restored: false` is what tells the editor to zoom-to-fit instead of
 *  dumping you on empty grid at (0,0). */
const loadViewport = (canvasId: string): { viewport: Viewport; restored: boolean } => {
  try {
    const raw = localStorage.getItem(`canvas-vp:${canvasId}`);
    if (raw) {
      const vp = JSON.parse(raw);
      if (
        typeof vp?.x === "number" &&
        typeof vp?.y === "number" &&
        typeof vp?.scale === "number"
      ) {
        return { viewport: vp, restored: true };
      }
    }
  } catch {
    /* ignore */
  }
  return { viewport: { x: 0, y: 0, scale: 1 }, restored: false };
};

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The box enclosing `nodes` in canvas coords, or null if there are none.
 *  Every kind counts — the INBOX tray included — so a fit really does show
 *  everything. Auto-height nodes (text cards, sections) mirror their measured
 *  height back into `node.height`, so stored geometry tracks what's rendered. */
const boundsOf = (nodes: CanvasNode[]): Bounds | null => {
  if (!nodes.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  return { minX, minY, maxX, maxY };
};

/** Screen margin (px) left around the content when fitting. */
const FIT_PAD = 64;

/** The viewport that centres `b` in a `width`×`height` container. Zoom is capped
 *  at 1: fitting never MAGNIFIES, or framing one small note would slam you to
 *  300% — it only ever zooms out far enough to show the box. */
const fitViewport = (b: Bounds, width: number, height: number): Viewport => {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const scale = Math.min(
    1,
    Math.max(
      MIN_SCALE,
      Math.min((width - 2 * FIT_PAD) / bw, (height - 2 * FIT_PAD) / bh),
    ),
  );
  return {
    scale,
    x: width / 2 - (b.minX + bw / 2) * scale,
    y: height / 2 - (b.minY + bh / 2) * scale,
  };
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
  filterAssigneeId = null,
}: {
  canvasId: string;
  canvasName: string;
  /** Show only this assignee's cards across every section (TD-59). Render-only
   *  — never patched into Liveblocks storage, so it can't fight over section
   *  heights with peers who have a different (or no) filter active. */
  filterAssigneeId?: string | null;
}) {
  const nodesMap = useStorage((root) => root.nodes);
  const others = useOthers();
  // Presence only means something while the socket is up. Liveblocks does NOT
  // clear `others` when the room is disconnected on purpose (see
  // useRoomIdlePause), and lags ~5s behind a real drop — so peers would
  // otherwise sit frozen on screen looking live. Dim them instead of hiding
  // them: they're the last known truth, just not current.
  const peersStale = useStatus() !== "connected";
  const staleOpacity = peersStale ? 0.35 : 1;
  // My auth user id (from liveblocks-auth prepareSession) — stamps who created
  // a section so its board-picker stays private to that user.
  const myId = useSelf((me) => me.id);
  const updateMyPresence = useUpdateMyPresence();
  const history = useHistory();
  const broadcast = useBroadcastEvent();
  const {
    subscribeLocalChange,
    refreshFromRemote,
    applyRemotePatch,
    undoDelete,
    openTaskIds,
    nodes: taskNodes,
    taskMap,
    projects,
    registerPlacement,
    registerOpenCanvas,
    canvasNotes,
    addCanvasNote,
    moveCanvasNote,
    resolveCanvasNote,
    deleteCanvasNote,
  } = useWorkspace();

  // useStorage's root is ToJson<Storage>, so `nodes` is a plain readonly
  // record (id → node), not a Map — hence Object.values, not .values().
  const nodes: CanvasNode[] = useMemo(
    () => (nodesMap ? Object.values(nodesMap).map((n) => ({ ...n })) : []),
    [nodesMap],
  );

  // This editor only mounts client-side (after the canvas fetch resolves), so
  // reading localStorage in the initializer is safe — no SSR/hydration mismatch.
  const [saved] = useState(() => loadViewport(canvasId));
  const [viewport, setViewport] = useState<Viewport>(saved.viewport);
  // First visit to this canvas (nothing saved): frame the content once it has
  // settled, instead of opening on empty grid at (0,0). Cleared once the fit
  // lands — or as soon as you pan/zoom/click, so we never yank the view out
  // from under you. State, not just a ref: it also hides the pre-fit frame.
  const [pendingFit, setPendingFit] = useState(!saved.restored);
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
  // The section_group a section is currently being dragged over (drop target
  // highlight). null when no section is over any group.
  const [groupDropTarget, setGroupDropTarget] = useState<string | null>(null);
  // Which slot of `groupDropTarget`'s packing order the dragged section would
  // land in. A plain index, NOT the caret rect: this is set on every pointermove,
  // and a fresh rect object would defeat React's bail-out and re-render the whole
  // editor at pointer frequency. The rect is derived at render (see `dropCaret`).
  const [dropSlotIndex, setDropSlotIndex] = useState<number | null>(null);

  // Freehand pen. `pen` is the current ink (persisted per-user); `drawing` is
  // the in-flight stroke — a flat [x,y,…] list in canvas coords, shown as a live
  // preview until pointerup commits it to a `draw` node.
  const [pen, setPen] = useState<Pen>(() => loadPen(canvasId));
  const [drawing, setDrawing] = useState<number[] | null>(null);

  // Sticky-note compose popup: where to drop it (canvas coords, for the note)
  // plus where to draw the popup (screen coords — it's fixed-positioned, not
  // part of the pan/zoom transform). Cleared on submit/cancel.
  const [stickyDraft, setStickyDraft] = useState<{
    x: number;
    y: number;
    screenX: number;
    screenY: number;
  } | null>(null);
  const [stickyText, setStickyText] = useState("");

  // Count of image uploads in flight (paste/drop) — drives the "Pasting…" pill.
  const [uploading, setUploading] = useState(0);

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
  const [linkLines, setLinkLines] = useState<LinkLine[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const vpRef = useRef(viewport);
  const spaceRef = useRef(false);
  const toolRef = useRef(tool);
  const selectedRef = useRef(selected);
  const editingRef = useRef(editingId);
  const penRef = useRef(pen);
  // Last cursor position in canvas coords — where a pasted image lands.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  // Is a task-detail modal open over the canvas? TaskDetailModal has its own
  // document-level paste listener, so without this the canvas would ALSO drop a
  // node behind the modal on the same ⌘V that attaches the image to the task.
  const modalOpenRef = useRef(false);
  // Mirror of `pendingFit` for the pointer/wheel handlers, which are bound once.
  const pendingFitRef = useRef(pendingFit);
  useEffect(() => void (nodesRef.current = nodes), [nodes]);
  useEffect(() => void (vpRef.current = viewport), [viewport]);
  useEffect(() => void (toolRef.current = tool), [tool]);
  useEffect(() => void (selectedRef.current = selected), [selected]);
  useEffect(() => void (editingRef.current = editingId), [editingId]);
  useEffect(() => void (penRef.current = pen), [pen]);
  useEffect(() => void (modalOpenRef.current = openTaskIds.length > 0), [openTaskIds]);
  useEffect(() => void (pendingFitRef.current = pendingFit), [pendingFit]);

  /** Drop a not-yet-run first-visit fit — the user is driving the view now. */
  const cancelPendingFit = useCallback(() => {
    if (!pendingFitRef.current) return;
    pendingFitRef.current = false;
    setPendingFit(false);
  }, []);

  // The in-flight "jump to a peer's view" animation (0 = none). Declared up here
  // with cancelPendingFit because the camera moves further down (zoomAt, fitTo)
  // need `cancelJump` in their dep arrays — naming a later const there would be a
  // temporal-dead-zone error at render.
  const jumpRef = useRef(0);
  /** Abandon an in-flight jump — you're driving now, and two things moving the
   *  camera at once reads as a fight. */
  const cancelJump = useCallback(() => {
    if (!jumpRef.current) return;
    cancelAnimationFrame(jumpRef.current);
    jumpRef.current = 0;
  }, []);
  useEffect(() => () => cancelAnimationFrame(jumpRef.current), []);

  // Persist this user's own viewport (per-user, not shared with the room).
  // DEBOUNCED: zoom and pan fire continuously, and localStorage.setItem is a
  // synchronous main-thread write — doing it per wheel tick stalls the frame.
  // Only the resting position matters, so settle for 200ms first.
  //
  // Held off while a first-visit fit is pending: writing the placeholder (0,0)
  // viewport would mark the canvas "visited" and cancel the very fit we're
  // waiting on.
  useEffect(() => {
    if (pendingFit) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(`canvas-vp:${canvasId}`, JSON.stringify(viewport));
      } catch {
        /* ignore */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [viewport, canvasId, pendingFit]);

  // Share where our screen is pointed, so peers can click our avatar and land on
  // the same content at the same zoom. We publish the canvas point at the CENTRE
  // of the viewport plus the scale — not the raw pan offsets, which depend on
  // window size and would drop a laptop and a large monitor on different content.
  //
  // DEBOUNCED like the write above, and for a sharper reason: this one goes
  // outward. `useOthers()` here is unfiltered, so every presence update re-renders
  // each peer's whole editor (see the warning in SectionNode) — and pan/zoom fire
  // continuously. Only the resting view is worth sending. Held off while a
  // first-visit fit is pending so we never advertise the placeholder (0,0) frame.
  //
  // Reads the rect live rather than through the cached `containerRect` helper:
  // that's declared further down the component, so naming it in this dep array
  // would be a temporal-dead-zone error at render. Once per 200ms settle, a
  // layout read is cheap (`zoomAtCenter` and `placementPoint` do the same).
  useEffect(() => {
    if (pendingFit) return;
    const t = setTimeout(() => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect?.width || !rect.height) return;
      updateMyPresence({
        view: {
          cx: (rect.width / 2 - viewport.x) / viewport.scale,
          cy: (rect.height / 2 - viewport.y) / viewport.scale,
          scale: viewport.scale,
        },
      });
    }, 200);
    return () => clearTimeout(t);
  }, [viewport, pendingFit, updateMyPresence]);

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
        else if (signal.kind === "notesRefetch")
          broadcast({ type: "canvas-notes-changed" });
        else broadcast({ type: "tasks-changed" });
      }),
    [subscribeLocalChange, broadcast],
  );
  useEventListener(({ event }) => {
    if (event.type === "task-patch") applyRemotePatch(event.taskId, event.patch as TaskEdit);
    else if (event.type === "tasks-changed") refreshFromRemote();
    // A peer's sticky changed — reload just this canvas's notes, not the
    // whole task/project state (a room IS one canvas, so no payload needed).
    else if (event.type === "canvas-notes-changed") registerOpenCanvas(canvasId);
  });

  // Tell WorkspaceContext which canvas is on screen, so its poll/remote-
  // refresh loop keeps this canvas's stickies current too. Mirrors
  // registerPlacement below.
  useEffect(() => {
    registerOpenCanvas(canvasId);
    return () => registerOpenCanvas(null);
  }, [canvasId, registerOpenCanvas]);

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

  // Derive every section_group's column layout from its members: slot each
  // member section into place and auto-fit the group's box, mirroring the
  // results into storage. The rounded guard in computeGroupLayout prevents a
  // write loop, and nodes being dragged are skipped so a live drag owns its own
  // position (a released/captured section then snaps in on the next pass).
  useEffect(() => {
    const patches = computeGroupLayout(nodes, draggingIds);
    if (patches.length) patchMany(patches);
  }, [nodes, draggingIds, patchMany]);

  /* -------- System groups: INBOX / BACKLOG / LATER / DONE THIS WEEK -------- */

  /** Board id → name, for lane titles (a lane's `content` is its board name,
   *  exactly like a hand-bound section's). */
  const boardNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) for (const b of p.boards ?? []) m.set(b.id, b.name);
    return m;
  }, [projects]);

  /**
   * Reconcile the machine-managed groups and their per-board lanes — the same
   * derive-and-mirror-back shape as the group layout above.
   *
   * Node ids are DERIVED from the canvas + board (`systemLaneId`) rather than
   * random, which is what makes this safe to run in every client at once:
   * storage is a LiveMap keyed by node id, so two clients creating "the Platform
   * lane" converge on one entry instead of racing to two. Writes only happen
   * when the desired set differs from what's there, so this can't loop.
   *
   * The four kinds differ in exactly two ways:
   *
   *   • Which boards want a lane. INBOX asks who is UNCLAIMED
   *     (`boardsNeedingInbox`); the other three ask who has a card pinned to
   *     their lanes (`boardsFiledInSystemGroup`). Same answer shape, opposite
   *     question — an inbox lane means "unpinned", so nothing ever points at it.
   *   • Whether the group itself survives an empty canvas. INBOX comes and goes
   *     with the work it holds; the parking lots stay put, because they're
   *     destinations you send cards TO (a tray that vanishes when you empty it
   *     can't be aimed at).
   */
  useEffect(() => {
    if (!nodesMap) return;
    // Where the tray column starts. Measured against USER content only — include
    // the trays and each new one would be placed left of the last, so the column
    // would march off to infinity as the set grew.
    const anchors = nodes.filter(
      (n) => n.kind !== "draw" && systemGroupOf(n) === null,
    );
    const baseX = Math.round(
      (anchors.length ? Math.min(...anchors.map((n) => n.x)) : 0) -
        NEW_GROUP_SIZE.width -
        120,
    );
    const baseY = Math.round(
      anchors.length ? Math.min(...anchors.map((n) => n.y)) : 0,
    );
    const nodeIds = new Set(nodes.map((n) => n.id));
    const creates: StoredNode[] = [];
    const removes: string[] = [];
    const repairs: { id: string; patch: Partial<StoredNode> }[] = [];

    SYSTEM_GROUPS.forEach((kind, i) => {
      const groupId = systemGroupId(kind, canvasId);
      const group = nodes.find((n) => n.id === groupId);
      const existingLanes = nodes.filter(
        (n) => n.kind === "section" && systemGroupOf(n) === kind,
      );
      const wanted =
        kind === "inbox"
          ? boardsNeedingInbox(nodes, taskNodes, taskMap)
          : boardsFiledInSystemGroup(kind, canvasId, taskNodes, taskMap);
      const wantedIds = new Set(
        [...wanted].map((b) => systemLaneId(kind, canvasId, b)),
      );

      // Lanes whose board has nothing here any more — drop them, so an emptied
      // tray shrinks away instead of leaving a wall of empty boxes.
      removes.push(
        ...existingLanes.filter((n) => !wantedIds.has(n.id)).map((n) => n.id),
      );
      if (kind === "inbox" && !wanted.size) {
        // Nothing to triage: the INBOX group goes too.
        if (group) removes.push(groupId);
        return;
      }

      if (!group)
        creates.push({
          id: groupId,
          kind: "section_group",
          content: SYSTEM_GROUP_TITLE[kind],
          // Parked clear of existing content, to the LEFT of everything and
          // stacked in `SYSTEM_GROUPS` order — these are trays you glance at, not
          // something that should shove work aside. Movable afterwards: the slot
          // is only ever chosen once, at creation.
          x: baseX,
          y: baseY + i * (NEW_GROUP_SIZE.height + 120),
          width: NEW_GROUP_SIZE.width,
          height: NEW_GROUP_SIZE.height,
          color: null,
          // Behind the work sections, like any other group.
          position: 0,
          data: { [kind]: true, layout: "portrait" },
        });

      for (const boardId of wanted) {
        const laneId = systemLaneId(kind, canvasId, boardId);
        if (nodeIds.has(laneId)) continue;
        creates.push({
          id: laneId,
          kind: "section",
          content: boardId ? (boardNames.get(boardId) ?? "") : "",
          // computeGroupLayout owns the real position; these are a first frame.
          x: 0,
          y: 0,
          width: NEW_SECTION_SIZE.width,
          height: MIN_SECTION_HEIGHT,
          color: null,
          position: lanePosition(boardId),
          data: {
            [kind]: true,
            groupId,
            ...(boardId ? { boardId } : { name: "No board" }),
          },
        });
      }

      // RE-ADOPT any lane that has drifted out of its group. Membership lives on
      // the child (`data.groupId`), and several paths can clear it — deleting the
      // group releases its members, and so does dragging a lane out. Nothing put
      // it back: the loop above only creates lanes that are MISSING, and an
      // orphaned lane still exists. A non-member is invisible to
      // `computeGroupLayout`, so it kept stale coordinates forever and piled up
      // on its neighbours. The reconciler owns these lanes, so it repairs them.
      repairs.push(
        ...existingLanes
          .filter(
            (n) =>
              wantedIds.has(n.id) &&
              (n.data?.groupId !== groupId ||
                n.position !== lanePosition(laneBoardId(n))),
          )
          .map((n) => ({
            id: n.id,
            patch: {
              data: { ...(n.data ?? {}), groupId } as StoredNode["data"],
              position: lanePosition(laneBoardId(n)),
            },
          })),
      );
    });

    if (removes.length) removeMany(removes);
    for (const node of creates) putNode(node);
    if (repairs.length) patchMany(repairs);
  }, [
    nodesMap,
    nodes,
    taskNodes,
    taskMap,
    canvasId,
    boardNames,
    putNode,
    removeMany,
    patchMany,
  ]);

  /**
   * Keep BACKLOG pinned directly under THIS WEEK, and LATER directly under
   * BACKLOG — continuously, not just the first time all three exist together.
   * `computeGroupLayout` keeps auto-fitting each group's box to its own
   * content forever (a task added, a note expanded, a lane created all grow
   * it), so a one-time snapshot of the neighbour's height goes stale the
   * moment that neighbour grows, and the frames start to overlap.
   *
   * Re-deriving position from the live sibling height on every change is safe
   * against dragging: grabbing any one of the trio translates all three by an
   * equal delta (see `anchorTrioGroupIds` in `onNodePointerDown`), which
   * preserves the exact gap this effect expects — so after a drag the
   * derived position already matches where the drag put them and `place`
   * below is a no-op.
   */
  useEffect(() => {
    if (!nodesMap) return;
    const weekId = thisWeekGroupId(nodes);
    if (!weekId) return;
    const week = nodes.find((n) => n.id === weekId);
    if (!week) return;
    const backlog = nodes.find((n) => n.id === systemGroupId("backlog", canvasId));
    const later = nodes.find((n) => n.id === systemGroupId("later", canvasId));
    const patches: { id: string; patch: Partial<StoredNode> }[] = [];
    const place = (group: CanvasNode | undefined, x: number, y: number) => {
      if (group && (group.x !== x || group.y !== y)) {
        patches.push({ id: group.id, patch: { x, y } });
      }
    };
    let nextY = week.y + week.height + TRIO_GAP;
    if (backlog) {
      place(backlog, week.x, nextY);
      nextY += backlog.height + TRIO_GAP;
    }
    place(later, week.x, nextY);
    if (patches.length) patchMany(patches);
  }, [nodesMap, nodes, canvasId, patchMany]);

  /* ---- THIS WEEK: materialise the lane an agent's placement is waiting on ---- */

  /**
   * When something files a task on the THIS WEEK group for a board the group
   * doesn't cover yet, the pin names the lane's DERIVED id (`weekLaneId`) and
   * this creates the node — the client half of `resolveThisWeekSection`.
   *
   * It has to happen here rather than server-side because nodes live in
   * Liveblocks storage: a row the server inserted wouldn't reach an open canvas
   * until storage re-hydrated, whereas tasks arrive on the ≤2s poll. So the
   * server pins to the id the lane WILL have, and the placement shows up live.
   *
   * Unlike the INBOX reconciler above, this only ever CREATES. The group is
   * hand-curated, so once a lane exists it's an ordinary section the user owns —
   * renameable, movable, deletable, and never auto-removed when it empties.
   */
  useEffect(() => {
    if (!nodesMap) return;
    const groupId = thisWeekGroupId(nodes);
    if (!groupId) return;
    const missing = boardsNeedingWeekLane(nodes, taskNodes, taskMap);
    if (!missing.size) return;
    // Append after the group's current members, so a new lane never shoves its
    // way into the middle of an arrangement the user built by hand.
    let next =
      Math.max(0, ...groupMembers(nodes, groupId).map((m) => m.position)) + 1;
    for (const boardId of missing) {
      putNode({
        id: weekLaneId(groupId, boardId),
        kind: "section",
        content: boardId ? (boardNames.get(boardId) ?? "") : "",
        // computeGroupLayout owns the real position; these are just a first frame.
        x: 0,
        y: 0,
        width: NEW_SECTION_SIZE.width,
        height: MIN_SECTION_HEIGHT,
        color: null,
        position: next++,
        data: {
          groupId,
          ...(boardId ? { boardId } : { name: "No board" }),
        },
      });
    }
  }, [nodesMap, nodes, taskNodes, taskMap, boardNames, putNode]);

  /** Identity of the section set as far as membership and placement are
   *  concerned: which sections exist and which board each system lane serves.
   *  Every system lane's board is encoded, not just INBOX's — membership only
   *  needs the inbox ones, but `laneFor` below has to find the BACKLOG/LATER/DONE
   *  lane for a board, and would go stale if a lane's board changed silently.
   *  Deliberately excludes geometry: `nodes` gets a fresh identity on every
   *  pointermove of a drag (that's how positions travel), but where a task
   *  renders never depends on where a section sits. */
  const sectionsKey = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === "section")
        .map((n) => {
          const kind = systemGroupOf(n);
          return `${n.id}:${kind ?? ""}:${kind ? (laneBoardId(n) ?? "-") : ""}`;
        })
        .join("|"),
    [nodes],
  );

  /** The section nodes, with an identity that survives a pure move. Keyed on
   *  `sectionsKey` on purpose: without it the whole canvas re-resolves and every
   *  Section re-renders at pointer frequency, which is very visibly laggy. */
  const sectionNodes = useMemo(
    () => nodes.filter((n) => n.kind === "section"),
    // `nodes` is read but intentionally not a dep — `sectionsKey` is the part of
    // it this depends on. Adding `nodes` would defeat the whole point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sectionsKey],
  );

  /** Which notes link to which tasks — geometry-free, like `sectionsKey`, so the
   *  connector-measuring loop below isn't torn down and rebuilt on every
   *  pointermove of a drag. Empty string ⇒ there are no links at all. */
  const linksKey = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === "text" && linkedIdsOf(n).length > 0)
        .map((n) => `${n.id}:${linkedIdsOf(n).join(",")}`)
        .join("|"),
    [nodes],
  );

  /** Which Section shows which tasks, for this whole canvas. One pass, shared
   *  by every Section via context — see SectionMembershipContext. */
  const membership = useMemo(
    () => buildSectionMembership(sectionNodes, taskNodes, taskMap),
    [sectionNodes, taskNodes, taskMap],
  );

  /**
   * Resolve a placement to the lane a board's cards go to, creating the lane if
   * this canvas doesn't have one yet. The client twin of the server's
   * `resolvePlacementSection`, and it agrees with it by construction: same
   * derived lane ids, same "an existing member wins" rule, same tie-break.
   *
   * Reads nodes through `nodesRef` rather than closing over them, so the
   * callback stays stable — it's only ever called from an event handler, where
   * the ref is current, and a fresh identity per node change would re-register
   * the resolver on every pointermove of a drag.
   */
  const laneFor = useCallback(
    (placement: TaskPlacement, boardId: string | null): string | null => {
      if (placement === "inbox") return null;
      const all = nodesRef.current;
      const groupId =
        placement === "thisWeek"
          ? thisWeekGroupId(all)
          : systemGroupId(placement, canvasId);
      // Nothing starred THIS WEEK — there's no such destination on this canvas.
      if (!groupId) return null;

      // An existing member for this board always wins, so the user's own lanes
      // are what cards land in. Same ordering as `masterSectionsByBoard` and the
      // server's `ORDER BY position, id`.
      const existing = all
        .filter(
          (n) =>
            n.kind === "section" &&
            n.data?.groupId === groupId &&
            laneBoardId(n) === boardId,
        )
        .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))[0];
      if (existing) return existing.id;

      const laneId =
        placement === "thisWeek"
          ? weekLaneId(groupId, boardId)
          : systemLaneId(placement, canvasId, boardId);
      if (!all.some((n) => n.id === laneId)) {
        putNode({
          id: laneId,
          kind: "section",
          content: boardId ? (boardNames.get(boardId) ?? "") : "",
          // computeGroupLayout owns the real position; these are a first frame.
          x: 0,
          y: 0,
          width: NEW_SECTION_SIZE.width,
          height: MIN_SECTION_HEIGHT,
          color: null,
          // THIS WEEK is hand-arranged, so a new lane APPENDS rather than
          // shoving its way into the middle of it. A system tray is sorted by
          // the same board hash its reconciler uses.
          position:
            placement === "thisWeek"
              ? Math.max(0, ...groupMembers(all, groupId).map((m) => m.position)) + 1
              : lanePosition(boardId),
          data: {
            ...(placement === "thisWeek" ? {} : { [placement]: true }),
            groupId,
            ...(boardId ? { boardId } : { name: "No board" }),
          },
        });
      }
      return laneId;
    },
    [canvasId, boardNames, putNode],
  );

  // Lend the resolution to WorkspaceContext so its shared drag paths can re-pin
  // a dragged card correctly — they can't derive a card's Section themselves.
  useEffect(() => {
    const laneIds = new Set(
      sectionNodes.filter((n) => isInboxNode(n)).map((n) => n.id),
    );
    // Only the SYSTEM lanes, by id — BACKLOG/LATER/DONE THIS WEEK are ordinary
    // pin targets, so unlike `laneIds` this can't be used to decide pinning.
    const trayOf = new Map<string, SystemGroup>();
    for (const n of sectionNodes) {
      const kind = systemGroupOf(n);
      if (kind) trayOf.set(n.id, kind);
    }
    const sectionByTask = new Map<string, string>();
    for (const [sectionId, ids] of membership.bySection)
      for (const id of ids) sectionByTask.set(id, sectionId);
    registerPlacement({
      sectionOf: (taskId) => sectionByTask.get(taskId) ?? null,
      // Dropping into an INBOX lane means "unpin" — a lane shows its board's
      // unpinned tasks, so pinning to the lane would be a contradiction.
      pinFor: (sectionNodeId) =>
        sectionNodeId && !laneIds.has(sectionNodeId) ? sectionNodeId : null,
      membersOf: (sectionNodeId) =>
        (sectionNodeId && membership.bySection.get(sectionNodeId)) || new Set<string>(),
      groupOf: (taskId) => {
        const section = sectionByTask.get(taskId);
        return section ? (trayOf.get(section) ?? null) : null;
      },
      laneFor,
    });
    return () => registerPlacement(null);
  }, [sectionNodes, membership, registerPlacement, laneFor]);

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
  // The container's own rect, cached. `toCanvas` runs on EVERY pointermove (the
  // cursor broadcast), and `getBoundingClientRect` forces a synchronous layout —
  // brutal mid-pan, when the transform has just been invalidated and the canvas
  // holds hundreds of cards. The container is the fixed viewport element, so pan
  // and zoom (which transform an inner div) never move it; only a window resize
  // or page scroll can, and both are handled below.
  const rectRef = useRef<DOMRect | null>(null);
  const containerRect = useCallback((): DOMRect => {
    const cached = rectRef.current;
    if (cached) return cached;
    const rect = containerRef.current!.getBoundingClientRect();
    rectRef.current = rect;
    return rect;
  }, []);
  useEffect(() => {
    const invalidate = () => void (rectRef.current = null);
    window.addEventListener("resize", invalidate);
    window.addEventListener("scroll", invalidate, true);
    const ro = new ResizeObserver(invalidate);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("scroll", invalidate, true);
      ro.disconnect();
    };
  }, []);

  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRect();
      const vp = vpRef.current;
      return {
        x: (clientX - rect.left - vp.x) / vp.scale,
        y: (clientY - rect.top - vp.y) / vp.scale,
      };
    },
    [containerRect],
  );

  /* -------- node actions -------- */
  const createNode = useCallback(
    (kind: CanvasNodeKind, x: number, y: number) => {
      const size =
        kind === "section"
          ? NEW_SECTION_SIZE
          : kind === "section_group"
            ? NEW_GROUP_SIZE
            : NEW_TEXT_SIZE;
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
        // Stamp the creator on sections so only they see the board-picker while
        // it's unbound; peers see a placeholder until a board is chosen.
        data: kind === "section" && myId ? { createdBy: myId } : {},
      };
      putNode(node);
      setTool("select");
      setSelected(new Set([node.id]));
      if (kind === "text" || kind === "section_group") setEditingId(node.id);
    },
    [putNode, myId],
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

  /** Drop an uploaded image onto the canvas, centred at (cx, cy) in canvas
   *  coords. Scales the source pixels down to MAX_PLACE so a big screenshot
   *  arrives at a sane size; `data` keeps the natural size for aspect-locked
   *  resize. Selects it (in the select tool) so you can immediately move it. */
  const createImageNode = useCallback(
    (url: string, natW: number, natH: number, cx: number, cy: number) => {
      const longest = Math.max(natW, natH) || 1;
      const s = Math.min(1, MAX_PLACE / longest);
      const w = Math.max(1, Math.round(natW * s));
      const h = Math.max(1, Math.round(natH * s));
      const maxPos = nodesRef.current.reduce((m, nd) => Math.max(m, nd.position), 0);
      const node: StoredNode = {
        id: uid(),
        kind: "image",
        content: "",
        x: Math.round(cx - w / 2),
        y: Math.round(cy - h / 2),
        width: w,
        height: h,
        color: null,
        position: maxPos + 1,
        data: { url, naturalW: natW, naturalH: natH },
      };
      putNode(node);
      setTool("select");
      setSelected(new Set([node.id]));
    },
    [putNode],
  );

  /** Upload one image file and drop it at (cx, cy). Tracks an in-flight count
   *  so the "Pasting…" pill shows; awaits the upload before creating the node,
   *  so a node is never persisted without its blob URL. */
  const handleImageFile = useCallback(
    async (file: File, cx: number, cy: number) => {
      setUploading((n) => n + 1);
      try {
        const { url, w, h } = await uploadCanvasImage(canvasId, file);
        createImageNode(url, w, h, cx, cy);
      } catch {
        /* swallow — a failed upload just drops nothing */
      } finally {
        setUploading((n) => n - 1);
      }
    },
    [canvasId, createImageNode],
  );

  // Delete nodes, releasing (not deleting) any member sections of a deleted
  // section_group — the group is just a container, so its sections survive.
  const deleteNodes = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      const releases: { id: string; patch: Partial<StoredNode> }[] = [];
      const removing = new Set(ids);
      for (const id of ids) {
        const n = nodesRef.current.find((x) => x.id === id);
        if (n?.kind !== "section_group") continue;
        for (const m of groupMembers(nodesRef.current, id)) {
          if (removing.has(m.id)) continue; // being deleted anyway
          // A system lane is owned by the reconciler, not by the user — releasing
          // it would strand it outside any group, where nothing lays it out and
          // nothing puts it back. Leave its `groupId` alone: the reconciler
          // recreates the group and re-adopts the lane.
          if (systemGroupOf(m)) continue;
          const rest = { ...(m.data ?? {}) };
          delete rest.groupId;
          releases.push({ id: m.id, patch: { data: rest as StoredNode["data"] } });
        }
      }
      if (releases.length) patchMany(releases);
      removeMany(ids);
    },
    [patchMany, removeMany],
  );

  const deleteSelected = useCallback(() => {
    const ids = [...selectedRef.current];
    if (!ids.length) return;
    deleteNodes(ids);
    setSelected(new Set());
    setEditingId(null);
  }, [deleteNodes]);

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
    const anyLinks = linksKey.length > 0;
    if (!anyLinks && !linkDrag) {
      // Nothing to track — clear any stale lines on the next frame (deferred so
      // this isn't a synchronous setState in the effect body).
      const raf = requestAnimationFrame(() =>
        setLinkLines((prev) => (prev.length ? [] : prev)),
      );
      return () => cancelAnimationFrame(raf);
    }
    let raf = 0;
    let prev: LinkLine[] = [];
    // Cache each linked card's element. `querySelector` across a canvas holding
    // hundreds of cards, once per link per FRAME, was the dominant cost here.
    // Revalidated by `isConnected`, so a re-rendered card is re-found rather
    // than held stale.
    const els = new Map<string, HTMLElement>();
    const cardEl = (inner: HTMLElement, taskId: string): HTMLElement | null => {
      const hit = els.get(taskId);
      if (hit?.isConnected) return hit;
      const found = inner.querySelector(
        `[data-task-id="${CSS.escape(taskId)}"]`,
      ) as HTMLElement | null;
      if (found) els.set(taskId, found);
      else els.delete(taskId);
      return found;
    };
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
            const el = cardEl(inner, taskId);
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
        // Field compare rather than JSON.stringify — this runs every frame, and
        // the whole point is to NOT re-render when the geometry is unchanged.
        const changed =
          out.length !== prev.length ||
          out.some((l, i) => {
            const q = prev[i];
            return (
              l.key !== q.key ||
              l.x1 !== q.x1 ||
              l.y1 !== q.y1 ||
              l.x2 !== q.x2 ||
              l.y2 !== q.y2
            );
          });
        if (changed) {
          prev = out;
          setLinkLines(out);
        }
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // Keyed on `linksKey`, not `nodes`: the loop reads `nodesRef.current`, so
    // depending on `nodes` only tore the loop down and rebuilt it on every
    // pointermove of every drag.
  }, [linksKey, linkDrag]);

  /* -------- zoom -------- */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      // Cached rect: a wheel-driven zoom fires continuously, and reading it live
      // forces a layout flush per tick right after the transform changed.
      const rect = containerRect();
      cancelJump();
      setViewport((vp) => {
        const mx = clientX - rect.left;
        const my = clientY - rect.top;
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vp.scale * factor));
        const k = next / vp.scale;
        return { scale: next, x: mx - (mx - vp.x) * k, y: my - (my - vp.y) * k };
      });
    },
    [containerRect, cancelJump],
  );

  /* -------- fit to content -------- */
  /** Frame `ids` (or everything, when omitted/empty) in the viewport. */
  const fitTo = useCallback(
    (ids?: Iterable<string>) => {
      const wanted = ids ? new Set(ids) : null;
      const subject = wanted?.size
        ? nodesRef.current.filter((n) => wanted.has(n.id))
        : nodesRef.current;
      const b = boundsOf(subject);
      if (!b) return;
      const rect = containerRect();
      if (!rect.width || !rect.height) return;
      cancelJump();
      setViewport(fitViewport(b, rect.width, rect.height));
    },
    [containerRect, cancelJump],
  );

  /* -------- jump to a peer's view -------- */
  /** Adopt someone else's view: put `view`'s centre at the centre of our own
   *  container, at their zoom. The inverse of the centre maths we broadcast.
   *
   *  Animated rather than snapped — a jump across the canvas is otherwise
   *  indistinguishable from the canvas being swapped out, and you lose your
   *  bearings. */
  const jumpTo = useCallback(
    (view: { cx: number; cy: number; scale: number }) => {
      const rect = containerRect();
      if (!rect.width || !rect.height) return;
      cancelPendingFit();
      cancelJump();
      const from = vpRef.current;
      const toScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale));
      // Where WE are pointed, in the same centre+scale terms they broadcast.
      const fromCx = (rect.width / 2 - from.x) / from.scale;
      const fromCy = (rect.height / 2 - from.y) / from.scale;
      // Already looking at it — don't spend 320ms of renders to say so. Compared
      // in screen pixels, so the threshold means the same thing at every zoom.
      if (
        Math.abs(fromCx - view.cx) * toScale < 1 &&
        Math.abs(fromCy - view.cy) * toScale < 1 &&
        Math.abs(from.scale - toScale) < 0.01
      )
        return;
      const zoomRatio = toScale / from.scale;
      const t0 = performance.now();
      const step = () => {
        const p = Math.min(1, (performance.now() - t0) / JUMP_MS);
        const k = 1 - (1 - p) ** 3; // ease-out cubic
        // Interpolate the CENTRE POINT and derive the pan from it, rather than
        // lerping x/y directly: x/y are scale-dependent, so tweening them
        // alongside a changing zoom lets the focal point wander off mid-flight.
        // Zoom itself is multiplicative, hence geometric — a linear lerp from
        // 30% to 200% would spend most of the animation near the top and land
        // as a lurch.
        const scale = from.scale * zoomRatio ** k;
        const cx = fromCx + (view.cx - fromCx) * k;
        const cy = fromCy + (view.cy - fromCy) * k;
        setViewport({
          scale,
          x: rect.width / 2 - cx * scale,
          y: rect.height / 2 - cy * scale,
        });
        jumpRef.current = p < 1 ? requestAnimationFrame(step) : 0;
      };
      jumpRef.current = requestAnimationFrame(step);
    },
    [containerRect, cancelPendingFit, cancelJump],
  );

  /** What the fit depends on — geometry only, and rounded, so this doesn't churn
   *  on sub-pixel height corrections. */
  const boundsKey = useMemo(() => {
    const b = boundsOf(nodes);
    return b
      ? `${Math.round(b.minX)},${Math.round(b.minY)},${Math.round(b.maxX)},${Math.round(b.maxY)}`
      : "";
  }, [nodes]);

  // First-visit auto-fit. Deliberately NOT on the first storage snapshot: the
  // INBOX reconciler adds its group + lanes (to the LEFT of everything) once
  // task data lands, and auto-height nodes only report their real heights after
  // a render — fitting immediately would frame a half-built canvas. So wait for
  // the bounds to hold still, with a hard cap in case something keeps nudging
  // them.
  const fitDeadlineRef = useRef(0);
  useEffect(() => {
    if (!pendingFit) return;
    if (!nodesMap) return; // still connecting — nothing to frame yet
    if (!fitDeadlineRef.current) fitDeadlineRef.current = performance.now() + 2000;
    const wait = Math.max(0, Math.min(250, fitDeadlineRef.current - performance.now()));
    const t = setTimeout(() => {
      if (boundsKey) fitTo(); // empty canvas: nothing to frame, just reveal it
      setPendingFit(false);
    }, wait);
    return () => clearTimeout(t);
  }, [pendingFit, nodesMap, boundsKey, fitTo]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelPendingFit();
      cancelJump();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else {
        setViewport((vp) => ({ ...vp, x: vp.x - e.deltaX, y: vp.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, cancelPendingFit, cancelJump]);

  /* -------- keyboard -------- */
  useEffect(() => {
    // Also treat "a task modal is open" as typing: it owns the keyboard while
    // it's up (its own Escape closes it, ←/→ step the lightbox), so canvas
    // shortcuts must not fire behind it — Backspace especially, which would
    // delete the selected nodes out of sight.
    const isTyping = () => {
      const el = document.activeElement;
      return (
        modalOpenRef.current ||
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
        // A pending task-delete takes priority over the node history, so Ctrl+Z
        // right after a DELETE brings the task back; otherwise undo canvas nodes.
        if (e.shiftKey) history.redo();
        else if (!undoDelete()) history.undo();
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
        case "g":
        case "G":
          setTool("group");
          break;
        case "p":
        case "P":
          setTool("draw");
          break;
        case "e":
        case "E":
          setTool("erase");
          break;
        case "n":
        case "N":
          setTool("sticky");
          break;
        case "v":
        case "V":
          setTool("select");
          break;
        case "f":
        case "F":
          // Frame what you've got selected; with nothing selected, the whole
          // canvas — the way back to the overview.
          fitTo(selectedRef.current);
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
  }, [history, deleteSelected, nudge, undoDelete, fitTo]);

  /* -------- paste an image (⌘/Ctrl+V) -------- */
  // Where a pasted image lands: under the cursor if we've seen it, else the
  // centre of the current viewport (converted to canvas coords).
  const placementPoint = useCallback(() => {
    if (lastPointerRef.current) return lastPointerRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    const vp = vpRef.current;
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (rect.width / 2 - vp.x) / vp.scale,
      y: (rect.height / 2 - vp.y) / vp.scale,
    };
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Don't hijack paste while typing into a text node / input, or while a
      // task-detail modal is open — that modal handles the paste itself.
      const el = document.activeElement;
      if (
        modalOpenRef.current ||
        editingRef.current !== null ||
        (el instanceof HTMLElement && (el.tagName === "TEXTAREA" || el.tagName === "INPUT"))
      )
        return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            const p = placementPoint();
            void handleImageFile(file, p.x, p.y);
          }
          break;
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [placementPoint, handleImageFile]);

  /* -------- drag & drop image files -------- */
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault(); // allow the drop
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (!files.length) return;
      e.preventDefault();
      // Drop the first at the cursor; stagger any extras so they don't stack.
      files.forEach((file, i) => {
        const p = toCanvas(e.clientX + i * 16, e.clientY + i * 16);
        void handleImageFile(file, p.x, p.y);
      });
    },
    [toCanvas, handleImageFile],
  );

  /* -------- pointer: nodes (select + drag) -------- */
  const onNodePointerDown = useCallback(
    (e: ReactPointerEvent, node: CanvasNode) => {
      if (e.button !== 0 || spaceRef.current) return;
      // Pen strokes bubble to the background while the draw/erase tools are
      // active, so you can keep drawing straight over the ink and the eraser can
      // hit-test strokes via `data-draw-id`. With the Select tool they behave
      // like any other node — click to select, drag to move.
      if (node.kind === "draw" && toolRef.current !== "select") return;
      // The pen and eraser are drag-over-canvas tools: a pointer-down on ANY
      // node (image, note, section) must also fall through to the background so
      // you can draw a stroke straight over it and the eraser can reach ink
      // beneath. Without this an image/note swallows the press (its grab/move)
      // and you can't draw over it.
      if (toolRef.current === "draw" || toolRef.current === "erase") return;
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
      // A section_group moves together with its members: seed the drag with the
      // group + every section it holds so they translate as one (the column
      // re-derives afterward and confirms the slots — no jump).
      const moveIds = new Set(sel);
      if (node.kind === "section_group") {
        for (const m of groupMembers(nodesRef.current, node.id)) moveIds.add(m.id);
        // THIS WEEK / BACKLOG / LATER travel as one rigid unit — grabbing any
        // one of the three drags the other two along with it, preserving
        // whatever relative offset they currently sit at.
        const trio = anchorTrioGroupIds(nodesRef.current, canvasId);
        if (trio.has(node.id)) {
          for (const gid of trio) {
            if (gid === node.id) continue;
            moveIds.add(gid);
            for (const m of groupMembers(nodesRef.current, gid)) moveIds.add(m.id);
          }
        }
      }
      const origin = new Map(
        nodesRef.current
          .filter((n) => moveIds.has(n.id))
          .map((n) => [n.id, { x: n.x, y: n.y }] as const),
      );
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      let lastDx = 0;
      let lastDy = 0;
      // Only a plain section can be dropped into a group (no nested groups), and
      // only one that's actually part of this drag — a shift-click that
      // deselected it leaves it out of `origin`, so it never moves and must not
      // re-parent either.
      const capturable = node.kind === "section" && moveIds.has(node.id);
      // The grab point in canvas coords — the anchor for group hit-testing,
      // translated below by the same dx/dy as the node so it stays glued to the
      // spot you grabbed. Sampled once here rather than re-derived from the live
      // viewport each move: the drag moves nodes using the `scale` captured
      // above, so a live lookup would drift from where the node is actually
      // drawn if the viewport moves mid-drag.
      const grab = toCanvas(e.clientX, e.clientY);

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;
        lastDx = dx;
        lastDy = dy;
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
        // Highlight the group the cursor is over, and mark the slot it'd land in.
        if (capturable) {
          const px = grab.x + dx;
          const py = grab.y + dy;
          const g = groupAtPoint(nodesRef.current, px, py);
          setGroupDropTarget(g ? g.id : null);
          if (g) {
            const layout = groupLayoutOf(g);
            const siblings = groupMembers(nodesRef.current, g.id).filter(
              (m) => m.id !== node.id,
            );
            setDropSlotIndex(
              slotIndexForDrop(siblings, layout === "landscape" ? px : py, layout),
            );
          } else {
            setDropSlotIndex(null);
          }
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setGroupDropTarget(null);
        setDropSlotIndex(null);
        if (moved) {
          history.resume();
          setDraggingIds(new Set());
          // Settle a dragged section into (or out of) a group by where the CURSOR
          // released. Inside a group → set membership + a slot; the layout mirror
          // then snaps it into place. Outside all groups → release it.
          if (capturable) {
            const px = grab.x + lastDx;
            const py = grab.y + lastDy;
            const g = groupAtPoint(nodesRef.current, px, py);
            // Re-read: `node` is a pointerdown snapshot, so merging its `data`
            // would revert anything written to this section during the drag (a
            // peer binding a board, a rename).
            const cur = nodesRef.current.find((n) => n.id === node.id) ?? node;
            const currentGid = cur.data?.groupId as string | undefined;
            // A system lane can be dragged around, but never re-parented: the
            // reconciler owns which group it belongs to. Dropping it elsewhere (or
            // outside every group) would strand it where nothing lays it out and
            // nothing adopts it back — it would just pile up on its neighbours.
            if (systemGroupOf(cur)) return;
            if (g) {
              const siblings = groupMembers(nodesRef.current, g.id).filter(
                (m) => m.id !== node.id,
              );
              // Slot it by where it landed along the group's own axis — down the
              // column in portrait, across the row in landscape.
              const layout = groupLayoutOf(g);
              patchMany([
                {
                  id: node.id,
                  patch: {
                    data: { ...cur.data, groupId: g.id } as StoredNode["data"],
                    position: slotPositionForDrop(
                      siblings,
                      layout === "landscape" ? px : py,
                      layout,
                    ),
                  },
                },
              ]);
            } else if (currentGid) {
              const rest = { ...(cur.data ?? {}) };
              delete rest.groupId;
              patchMany([{ id: node.id, patch: { data: rest as StoredNode["data"] } }]);
            }
          }
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [patchMany, history, toCanvas, canvasId],
  );

  /* -------- pointer: background (pan / create / marquee) -------- */
  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      // You're driving now — neither a pending first-visit fit nor a jump onto
      // someone else's view may move the camera mid-interaction.
      cancelPendingFit();
      cancelJump();
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

      if (toolRef.current === "group") {
        e.preventDefault();
        const p = toCanvas(e.clientX, e.clientY);
        createNode("section_group", p.x, p.y);
        return;
      }

      if (toolRef.current === "sticky") {
        e.preventDefault();
        const p = toCanvas(e.clientX, e.clientY);
        setStickyDraft({
          x: Math.round(p.x),
          y: Math.round(p.y),
          screenX: e.clientX,
          screenY: e.clientY,
        });
        setStickyText("");
        setTool("select");
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
    [toCanvas, createNode, createDrawNode, removeMany, cancelPendingFit, cancelJump],
  );

  /* -------- live cursor broadcast -------- */
  const onContainerPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const p = toCanvas(e.clientX, e.clientY);
      lastPointerRef.current = p; // where a paste will land
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

  /** The node mutations handed to every CanvasNodeHost. ONE stable object: it's
   *  part of each host's memo compare, so if this were rebuilt per render the
   *  whole memo boundary would be pointless. Each method takes its node/id, so
   *  nothing here closes over a particular node. */
  const nodeApi = useMemo<NodeApi>(
    () => ({
      pointerDown: (e, node) => onNodePointerDown(e, node),
      startEditing: (id) => {
        setSelected(new Set([id]));
        setEditingId(id);
      },
      stopEditing: () => setEditingId(null),
      patch: (id, patch) =>
        patchMany([{ id, patch: patch as Partial<StoredNode> }]),
      resizeStart: () => history.pause(),
      resizeEnd: () => history.resume(),
      setThisWeek: (node, thisWeek) => {
        const updates: { id: string; patch: Partial<StoredNode> }[] = [
          { id: node.id, patch: { data: { ...node.data, thisWeek } } },
        ];
        // One THIS WEEK group per canvas: marking this one demotes any other.
        // Server-side resolution picks a single group, so two flagged groups
        // would silently make one of them a decoy.
        if (thisWeek) {
          for (const other of nodesRef.current) {
            if (other.id !== node.id && isThisWeekGroup(other)) {
              updates.push({
                id: other.id,
                patch: { data: { ...other.data, thisWeek: false } },
              });
            }
          }
        }
        patchMany(updates);
      },
      remove: (id) => {
        deleteNodes([id]);
        setSelected((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      },
      linkStart: (e, node) => startLink(e, node),
    }),
    [onNodePointerDown, patchMany, history, deleteNodes, startLink],
  );

  // The insertion caret for a pending section→group drop, derived from the slot
  // index rather than stored — so it also tracks the group as its box grows, and
  // costs nothing on the pointermoves where the slot didn't change.
  const dropCaret = useMemo(() => {
    if (dropSlotIndex === null || groupDropTarget === null) return null;
    const g = nodes.find((n) => n.id === groupDropTarget);
    if (!g) return null;
    const members = groupMembers(nodes, g.id).filter((m) => !draggingIds.has(m.id));
    return slotCaretRect(g, members, dropSlotIndex, groupLayoutOf(g));
  }, [dropSlotIndex, groupDropTarget, nodes, draggingIds]);

  // Frames render behind everything (they're backdrops); text + sections layer
  // by z-order among themselves.
  // Section groups are backdrops for their members, so they render in a back
  // layer (behind everything else); within each band we keep z-order by
  // `position`.
  const ordered = [...nodes].sort((a, b) => {
    const ga = a.kind === "section_group" ? 0 : 1;
    const gb = b.kind === "section_group" ? 0 : 1;
    return ga - gb || a.position - b.position;
  });

  // The master section per DB board: the lane that board has inside the THIS
  // WEEK group. Sibling sections' "Send to …" buttons target it. There's no
  // separate master flag any more — the group's star is the only star, so a
  // board's master and this week's work can't drift apart (see
  // `masterSectionsByBoard`, which the server's SQL twin mirrors).
  const masterByBoard = new Map<string, { id: string; name: string }>();
  for (const [bid, n] of masterSectionsByBoard(nodes)) {
    // Label it the way its header reads: its own name if it has one, else the
    // board's (`content`) — this feeds siblings' "Send to …" button.
    const own = ((n.data?.name as string | undefined) ?? "").trim();
    masterByBoard.set(bid, { id: n.id, name: own || n.content });
  }

  const cursor = spaceDown
    ? "grab"
    : tool === "text" || tool === "section" || tool === "group" || tool === "draw"
      ? "crosshair"
      : tool === "erase"
        ? "cell"
        : "default";

  return (
    // Fill the positioned parent via absolute inset-0 rather than h-full: Safari
    // doesn't treat a flex item's height as "definite", so a percentage height
    // here collapses to 0 and (with overflow-hidden) blanks the whole canvas.
    <SectionMembershipProvider value={membership}>
    <div className="absolute inset-0 overflow-hidden">
      {/* Toolbar */}
      <div className="absolute left-3 top-3 z-20 flex flex-col items-start gap-1">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-sm">
          <ToolBtn active={tool === "select"} onClick={() => setTool("select")} title="Select (V)">⌖</ToolBtn>
          <ToolBtn active={tool === "text"} onClick={() => setTool("text")} title="Text (T)">T</ToolBtn>
          <ToolBtn active={tool === "sticky"} onClick={() => setTool("sticky")} title="Sticky note — team-visible, reviewable (N)">🗒</ToolBtn>
          <ToolBtn active={tool === "section"} onClick={() => setTool("section")} title="Section — outline of tasks (S)">▤</ToolBtn>
          <ToolBtn active={tool === "group"} onClick={() => setTool("group")} title="Section Group — container that stacks sections (G)">▣</ToolBtn>
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

      {/* Presence: who's here. Click someone to land on their view — same spot,
          same zoom — so "look at this over here" stops being a treasure hunt.
          Disabled until they've broadcast a view (they've only just joined). */}
      <div
        className={`absolute right-3 top-3 z-20 flex items-center -space-x-1.5 transition-opacity ${
          peersStale ? "opacity-40 saturate-50" : ""
        }`}
      >
        {others.slice(0, 6).map((o) => {
          const name = o.info?.name ?? "Someone";
          const view = o.presence?.view ?? null;
          // Jumping is purely local, so it still works while stale — but say so,
          // since where they were may no longer be where they are.
          const stale = peersStale ? " (not live — last known position)" : "";
          return (
            <button
              key={o.connectionId}
              type="button"
              disabled={!view}
              onClick={() => view && jumpTo(view)}
              title={
                view ? `Jump to ${name}'s view${stale}` : `${name} — no view yet${stale}`
              }
              aria-label={view ? `Jump to ${name}'s view` : name}
              // `relative` so the hover lift wins the stacking order: the row
              // overlaps via negative margin, so a static element can't z-index
              // itself above the avatar to its right.
              className="relative grid h-7 w-7 place-items-center rounded-full border-2 border-surface text-[11px] font-semibold text-white shadow-sm transition-transform enabled:cursor-pointer enabled:hover:z-10 enabled:hover:scale-110 disabled:cursor-default"
              style={{ backgroundColor: o.info?.color ?? "#7b68ee" }}
            >
              {name.slice(0, 1).toUpperCase()}
            </button>
          );
        })}
      </div>

      <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-md bg-surface/80 px-2 py-1 text-[11px] text-faint shadow-sm backdrop-blur">
        {tool === "text"
          ? "Click to drop a text block"
          : tool === "section"
            ? "Click to drop a board — name it, then outline your tasks"
            : tool === "group"
              ? "Click to drop a Section Group — then drag sections into it"
              : tool === "draw"
              ? "Drag to draw · pick colour & width on the left"
              : tool === "erase"
                ? "Drag across a stroke to erase it"
                : "T text · B board · P draw · E erase · F fit · paste/drop an image · space-drag to pan · ⌘-scroll to zoom"}
      </div>

      {/* Image upload in progress (paste / drop). */}
      {uploading > 0 ? (
        <div className="pointer-events-none absolute left-1/2 top-12 z-20 -translate-x-1/2 rounded-md bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent shadow-sm backdrop-blur">
          {uploading > 1 ? `Adding ${uploading} images…` : "Adding image…"}
        </div>
      ) : null}

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
        <ToolBtn
          onClick={() => fitTo(selected)}
          title="Fit — frame the selection, or the whole canvas (F)"
        >
          ⤢
        </ToolBtn>
      </div>

      {/* Canvas surface */}
      <div
        ref={containerRef}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onContainerPointerMove}
        onPointerLeave={onContainerPointerLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={[
          "absolute inset-0 touch-none select-none",
          // While the pen/eraser is active, force the tool cursor over every
          // node too — otherwise an image or note's own `cursor-grab` wins on
          // hover and misleads you into thinking it'll grab instead of draw.
          !spaceDown && tool === "draw" ? "[&_*]:cursor-crosshair!" : "",
          !spaceDown && tool === "erase" ? "[&_*]:cursor-cell!" : "",
        ].join(" ")}
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
            // Hide the pre-fit frame on a first visit, so you never see the
            // content flash at (0,0) before it's framed. Opacity, not display:
            // the nodes must still lay out, since the fit reads the heights
            // they measure. Always cleared with `pendingFit` (which has its own
            // deadline), so this can't leave the canvas blank.
            opacity: pendingFit ? 0 : undefined,
          }}
        >
          {ordered.map((node) => {
            const bid = node.data?.boardId as string | undefined;
            const master = bid ? masterByBoard.get(bid) : undefined;
            const other = master && master.id !== node.id ? master : null;
            return (
              <CanvasNodeHost
                key={node.id}
                node={node}
                selected={selected.has(node.id)}
                editing={editingId === node.id}
                smooth={!draggingIds.has(node.id)}
                scale={viewport.scale}
                canvasName={canvasName}
                isMaster={master?.id === node.id}
                masterSectionId={other?.id ?? null}
                masterSectionName={other?.name ?? null}
                groupMemberCount={
                  node.kind === "section_group"
                    ? groupMembers(nodes, node.id).length
                    : 0
                }
                groupDropActive={
                  node.kind === "section_group" && groupDropTarget === node.id
                }
                filterAssigneeId={filterAssigneeId}
                api={nodeApi}
              />
            );
          })}

          {/* Sticky notes (TD-55): Postgres-backed, not Liveblocks storage — see
              CanvasStickyNote's doc comment. Rendered as plain siblings in this
              same transformed container, so pan/zoom is free. */}
          {(canvasNotes[canvasId] ?? []).map((note) => (
            <CanvasStickyNote
              key={note.id}
              note={note}
              scale={viewport.scale}
              onMove={(x, y) => moveCanvasNote(canvasId, note.id, x, y)}
              onResolve={(resolved) => resolveCanvasNote(canvasId, note.id, resolved)}
              onDelete={() => deleteCanvasNote(canvasId, note.id)}
            />
          ))}

          {/* Insertion caret for a pending section→group drop. Rendered after the
              nodes (later sibling, no z-index — same trick as the connector svg
              below) because the dragged section paints over the group it's headed
              for, hiding the group's own drop hint. */}
          {dropCaret ? (
            <div
              className="pointer-events-none absolute rounded-full bg-accent"
              style={{
                left: dropCaret.x,
                top: dropCaret.y,
                width: dropCaret.w,
                height: dropCaret.h,
              }}
            />
          ) : null}

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
                  opacity: staleOpacity,
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
                  opacity: staleOpacity,
                  // Glide between the ~100ms-throttled presence updates. Nothing
                  // is moving while stale, so don't animate the last position.
                  transition: peersStale ? undefined : "transform 110ms linear",
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

      {/* Sticky-note compose popup. Screen-anchored (fixed), NOT a child of
          `innerRef` — a transformed ancestor would turn `fixed` into
          `absolute`-relative-to-it, which is not what we want here. */}
      {stickyDraft ? (
        <div
          className="fixed z-30 flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-2 shadow-lg"
          style={{ left: stickyDraft.screenX, top: stickyDraft.screenY, width: STICKY_WIDTH }}
        >
          <textarea
            autoFocus
            value={stickyText}
            onChange={(e) => setStickyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setStickyDraft(null);
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitStickyDraft();
              }
            }}
            placeholder="Note for the team…"
            rows={3}
            className="resize-none rounded-md border border-border bg-surface-2 p-1.5 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none"
          />
          <div className="flex justify-end gap-1.5">
            <button
              onClick={() => setStickyDraft(null)}
              className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              onClick={submitStickyDraft}
              disabled={!stickyText.trim()}
              className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      ) : null}
    </div>
    </SectionMembershipProvider>
  );

  function zoomAtCenter(factor: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function submitStickyDraft() {
    const note = stickyText.trim();
    if (note && stickyDraft) addCanvasNote(canvasId, stickyDraft.x, stickyDraft.y, { note });
    setStickyDraft(null);
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
