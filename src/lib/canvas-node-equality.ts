import type { CanvasNode } from "./types";
import type { RenderFilter } from "@/lib/task-filters";

/**
 * Does this node still look the same to the renderer?
 *
 * CanvasEditor derives its `nodes` array by cloning every node out of Liveblocks
 * storage, so a node's object IDENTITY changes on every storage write — even for
 * the nodes that didn't move. A drag writes on every `pointermove`, so identity
 * comparison would report "changed" for all of them and defeat any memoization.
 * We compare the fields the renderer actually reads instead.
 *
 * Lives apart from the component (and imports nothing but a type) so it can be
 * exercised directly — it's the whole basis of the canvas's memo boundary, and
 * getting it wrong means stale nodes on screen rather than merely slow ones.
 */
export const sameCanvasNode = (a: CanvasNode, b: CanvasNode): boolean =>
  a.id === b.id &&
  a.kind === b.kind &&
  a.content === b.content &&
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height &&
  a.color === b.color &&
  a.position === b.position &&
  // `data` is free-form (boardId, groupId, thisWeek, inbox/backlog/later/
  // doneThisWeek, layout, linkedTaskIds, …) — a deep compare here is what makes
  // a group's THIS WEEK star re-render without a prop of its own.
  // Reference check first — Liveblocks keeps it stable when untouched — so the
  // common per-pointermove path never serializes.
  (a.data === b.data || JSON.stringify(a.data ?? {}) === JSON.stringify(b.data ?? {}));

/** Everything one canvas node's renderer is fed. All primitives except `node`
 *  (compared by field, above) and `api`, which the editor keeps stable and which
 *  is therefore compared by reference — hence `unknown` here. */
export interface CanvasNodeRenderProps {
  node: CanvasNode;
  selected: boolean;
  editing: boolean;
  smooth: boolean;
  scale: number;
  canvasName: string;
  /** Derived: this section sits in the starred THIS WEEK group. */
  isMaster: boolean;
  masterSectionId: string | null;
  masterSectionName: string | null;
  groupMemberCount: number;
  groupDropActive: boolean;
  /** Section-only: show only some cards across every section on the canvas —
   *  one person's work, some boards' work, or both (TD-59/TD2-216). Purely a
   *  render filter, never written to storage. Compared by REFERENCE, which is
   *  why the editor builds it once with `useMemo` rather than per render. */
  filter: RenderFilter;
  api: unknown;
}

/** The `memo` comparator for a canvas node: true ⇒ skip the re-render. */
export const canvasNodeRenderPropsEqual = (
  p: CanvasNodeRenderProps,
  n: CanvasNodeRenderProps,
): boolean =>
  p.selected === n.selected &&
  p.editing === n.editing &&
  p.smooth === n.smooth &&
  // `scale` feeds ONLY an image's resize-handle math (see CanvasNode), and zoom
  // is continuous — comparing it for every node would re-render every section
  // and its whole card list on every wheel tick. Pan/zoom transforms the wrapper
  // element; nodes live in canvas coords inside it and don't care.
  (p.node.kind !== "image" || p.scale === n.scale) &&
  p.canvasName === n.canvasName &&
  p.isMaster === n.isMaster &&
  p.masterSectionId === n.masterSectionId &&
  p.masterSectionName === n.masterSectionName &&
  p.groupMemberCount === n.groupMemberCount &&
  p.groupDropActive === n.groupDropActive &&
  p.filter === n.filter &&
  p.api === n.api &&
  sameCanvasNode(p.node, n.node);
