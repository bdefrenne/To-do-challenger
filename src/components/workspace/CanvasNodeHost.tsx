"use client";

/**
 * A memoized wrapper around one canvas node.
 *
 * The canvas re-renders on every `pointermove` of a drag — that's how a node's
 * new x/y reaches the screen. Without a memo boundary here that cascades into
 * EVERY node: all sections re-render, and each one re-renders its whole card
 * list. On a canvas with ~50 task cards at ~120Hz that's thousands of component
 * renders a second, which is very visibly laggy.
 *
 * Two things make the boundary actually hold:
 *
 *  1. **A custom comparator** (`nodeHostPropsEqual`). CanvasEditor derives its
 *     `nodes` array by cloning every node out of Liveblocks storage, so a node's
 *     object identity changes on every storage write even when that node didn't
 *     move. A default shallow compare would therefore never match. We compare
 *     the node's *fields* instead.
 *  2. **Stable props.** Everything below is a primitive except `api`, which
 *     CanvasEditor memoizes once. The per-node closures CanvasNode wants
 *     (`onChange`, `onRemove`, …) are built HERE, inside the boundary, so their
 *     fresh identities cost nothing.
 */

import { memo, useMemo } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CanvasNode as CanvasNodeT } from "@/lib/types";
import {
  canvasNodeRenderPropsEqual,
  type CanvasNodeRenderProps,
} from "@/lib/canvas-node-equality";
import { CanvasNode as NodeView } from "./CanvasNode";

/** The node mutations a host needs. One stable object, memoized by CanvasEditor
 *  — every method takes the node/id explicitly so none of them close over it. */
export interface NodeApi {
  pointerDown: (e: ReactPointerEvent, node: CanvasNodeT) => void;
  startEditing: (id: string) => void;
  stopEditing: () => void;
  patch: (id: string, patch: Record<string, unknown>) => void;
  resizeStart: () => void;
  resizeEnd: () => void;
  setMaster: (node: CanvasNodeT, master: boolean) => void;
  remove: (id: string) => void;
  linkStart: (e: ReactPointerEvent, node: CanvasNodeT) => void;
}

/** As `CanvasNodeRenderProps`, with the real `api` type. `masterSection` is split
 *  into primitives (not a `{id,name}` object) so the comparator stays a flat
 *  field compare — the object is rebuilt inside the boundary. */
export interface CanvasNodeHostProps extends CanvasNodeRenderProps {
  api: NodeApi;
}

function CanvasNodeHostInner({
  node,
  selected,
  editing,
  smooth,
  scale,
  canvasName,
  isMaster,
  masterSectionId,
  masterSectionName,
  groupMemberCount,
  groupDropActive,
  api,
}: CanvasNodeHostProps) {
  // Rebuilt per render of THIS node only — inside the memo boundary, so a fresh
  // identity never propagates a re-render to anyone else.
  const masterSection = useMemo(
    () =>
      masterSectionId !== null
        ? { id: masterSectionId, name: masterSectionName ?? "" }
        : null,
    [masterSectionId, masterSectionName],
  );

  return (
    <NodeView
      node={node}
      selected={selected}
      editing={editing}
      smooth={smooth}
      scale={scale}
      canvasName={canvasName}
      isMaster={isMaster}
      masterSection={masterSection}
      groupMemberCount={groupMemberCount}
      groupDropActive={groupDropActive}
      onPointerDown={(e) => api.pointerDown(e, node)}
      onStartEditing={() => api.startEditing(node.id)}
      onStopEditing={api.stopEditing}
      onChange={(content) => api.patch(node.id, { content })}
      onResize={(height) => api.patch(node.id, { height })}
      onPatch={(patch) => api.patch(node.id, patch)}
      onResizeStart={api.resizeStart}
      onResizeEnd={api.resizeEnd}
      onSetMaster={(v) => api.setMaster(node, v)}
      onRemove={() => api.remove(node.id)}
      onLinkStart={
        node.kind === "text" ? (e) => api.linkStart(e, node) : undefined
      }
    />
  );
}

export const CanvasNodeHost = memo(CanvasNodeHostInner, canvasNodeRenderPropsEqual);
