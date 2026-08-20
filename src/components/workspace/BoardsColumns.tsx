"use client";

import { AlignJustify, GripVertical, LayoutGrid } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Board, Project, TaskPlacement } from "@/lib/types";
import {
  PLACEMENT_BAR,
  PLACEMENT_ORDER,
  placementOfTask,
  placementTitle,
  type PlacementMap,
  type PlacementTitles,
} from "@/lib/sections";
import { compareTaskOrder } from "@/lib/task-order";
import type { TaskUnit } from "@/lib/outline";
import { useWorkspace, type TaskNode } from "./WorkspaceContext";
import { TaskCard, TASK_DND_MIME } from "./TaskCard";
import { BoardModal } from "./BoardModal";
import { Avatar } from "@/components/ui/Badge";
import { useViewMode } from "@/components/ui/ViewToggle";
import { SeparatorHeader } from "./SeparatorHeader";
import { OutlineEditor } from "./OutlineEditor";
import { useOutlineDraft } from "./useOutlineDraft";
import { useDragSessionEnd } from "./useDragSessionEnd";

/** DnD payload type for dragging a whole board column (distinct from task
 *  cards, which use TASK_DND_MIME, so the two drag surfaces never collide). */
const BOARD_DND_MIME = "application/x-board-id";

/**
 * A project's Boards view: the triage ladder read top to bottom as one big
 * collapsible SEPARATOR per placement bucket (INBOX · DONE THIS WEEK · THIS
 * WEEK · BACKLOG · LATER), and inside each, the project's boards left→right
 * as columns — the same columns, in the same order, as before.
 *
 * The two axes are deliberate: the separator says WHEN you mean to do a thing,
 * the column says WHAT it belongs to. Status is neither, so it rides on the card
 * itself as the canvas's status ring + badge and a column mixes statuses the way
 * a canvas Section does. Dropping a card files it on that board and in that
 * bucket, and never touches its status.
 *
 * Which bucket a card is in is a CANVAS fact (a pin to a Section node), so it's
 * resolved against the flattened `sectionId → placement` map from
 * /api/placements — see `placementOfTask`. Drag a column by its handle to
 * reorder the boards (which also reorders the sidebar, since both read the
 * persisted board position).
 */
export function BoardsColumns({ project }: { project: Project }) {
  const {
    nodes,
    taskMap,
    openTask,
    fileTask,
    pendingPlacements,
    registerPlacementMap,
    addTask,
    fileTasks,
    reorderBoards,
  } = useWorkspace();
  const boards = useMemo(() => project.boards ?? [], [project.boards]);

  const [dragBoardId, setDragBoardId] = useState<string | null>(null);
  const [overBoardId, setOverBoardId] = useState<string | null>(null);
  // Paint only — `handleReorderDrop` still needs `dragBoardId`, and this fires
  // in capture, ahead of it.
  useDragSessionEnd(overBoardId !== null, () => setOverBoardId(null));
  // Only the "new board" modal opens from here — editing (and deleting) a board
  // lives in its own page's Board settings.
  const [creating, setCreating] = useState(false);

  /* ---- which bucket each card is in ---- */

  const [placements, setPlacements] = useState<PlacementMap>({});
  // The bands' own names, as they read on the canvas — a group can be renamed
  // there, and a band headed with the default while the canvas says something
  // else looks like a DIFFERENT bucket rather than the one you renamed.
  const [titles, setTitles] = useState<PlacementTitles>({});
  useEffect(() => {
    let alive = true;
    // Scoped to this project: canvases are per-project (TD-136), so an unscoped
    // map would bucket another project's sections into these bands.
    fetch(`/api/placements?projectId=${encodeURIComponent(project.id)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { placements?: PlacementMap; titles?: PlacementTitles }) => {
        if (!alive) return;
        setPlacements(d.placements ?? {});
        setTitles(d.titles ?? {});
        // Lend it to the workspace: it resolves a card's bucket from the pin id
        // alone, which covers every machine-made lane, and this adds the rest —
        // so what DELETE does to a card matches the band it's rendered in.
        registerPlacementMap(d.placements ?? {});
      })
      .catch(() => {
        /* leave both empty — everything reads as INBOX under the default names,
           rather than vanishing */
      });
    return () => {
      alive = false;
    };
  }, [registerPlacementMap, project.id]);

  // Where a just-filed card shows until the write lands: `fileTask` publishes the
  // bucket it's writing (the pin is the SERVER's to compute — it owns
  // `resolvePlacementSection`), and we read it over the resolved pin. Every path
  // in gets it — a drop here, and now the hover ↑/→/↓ and a DELETE parking a
  // done card, which go through the workspace rather than through this view.
  const nodeById = useMemo(
    () => new Map(nodes.map((n) => [n.id, n])),
    [nodes],
  );
  const parentOf = useCallback(
    (id: string) => nodeById.get(id)?.parentId ?? null,
    [nodeById],
  );

  /** Every task's bucket, resolved once. Needed as a MAP rather than per card
   *  because deciding where a card renders takes its parent's bucket as well as
   *  its own — and the nesting pass asks the same question again per child. */
  const placementByNode = useMemo(() => {
    const out = new Map<string, TaskPlacement>();
    for (const node of nodes)
      out.set(
        node.id,
        pendingPlacements[node.id] ??
          placementOfTask(node.id, taskMap, parentOf, placements),
      );
    return out;
  }, [nodes, taskMap, parentOf, placements, pendingPlacements]);

  /** This project's tasks, bucketed, then keyed by board within each bucket.
   *  Built in ONE pass — filtering per separator per board would be
   *  O(buckets × boards × tasks) against boards that already run to hundreds of
   *  cards. */
  const byPlacement = useMemo(() => {
    const boardIds = new Set(boards.map((b) => b.id));
    const out = new Map<TaskPlacement, Map<string, TaskNode[]>>();
    for (const placement of PLACEMENT_ORDER) out.set(placement, new Map());
    for (const node of nodes) {
      if (!node.boardId || !boardIds.has(node.boardId)) continue;
      const placement = placementByNode.get(node.id);
      if (!placement) continue;
      // Subtasks render nested under their parent, so only roots get bucketed —
      // and a card is only nested when its parent shares its COLUMN, i.e. the
      // same board AND the same bucket. Either mismatch promotes it to a root:
      // on the canvas a subtask pinned elsewhere is a root of the Section it was
      // pinned into, so nesting it under a parent that lives in another band
      // would show it in a bucket it isn't in, and never in the one it is.
      const parent = node.parentId ? nodeById.get(node.parentId) : null;
      if (
        parent &&
        parent.boardId === node.boardId &&
        placementByNode.get(parent.id) === placement
      )
        continue;
      const lane = out.get(placement);
      if (!lane) continue;
      const cards = lane.get(node.boardId);
      if (cards) cards.push(node);
      else lane.set(node.boardId, [node]);
    }
    for (const lane of out.values())
      for (const cards of lane.values()) cards.sort(compareTaskOrder);
    return out;
  }, [nodes, nodeById, boards, placementByNode]);

  /**
   * What "Clear Done" sweeps out of each column: the DONE cards in it, at ANY
   * depth — a done subtask sitting under an open parent is done work cluttering a
   * live band exactly as a done root card is, and it renders in this column too.
   *
   * Two cards are deliberately left out:
   *
   *   • A done card whose parent is ALSO being swept. It has no pin of its own —
   *     it renders here by inheriting its parent's placement — so it follows the
   *     parent into the tray for free. Pinning it as well would convert an
   *     inherited placement into a hand-made one, and the next time the parent
   *     moves, the child would stay behind.
   *   • Everything in DONE THIS WEEK, which is the destination — see the render.
   */
  const doneByPlacement = useMemo(() => {
    const boardIds = new Set(boards.map((b) => b.id));
    const done = new Set<string>();
    for (const node of nodes)
      if (node.status === "done" && node.boardId && boardIds.has(node.boardId))
        done.add(node.id);
    const out = new Map<TaskPlacement, Map<string, string[]>>();
    for (const id of done) {
      const node = nodeById.get(id);
      if (!node?.boardId) continue;
      // Inherits its way into the tray with its parent — nothing to write.
      if (node.parentId && done.has(node.parentId)) continue;
      const placement = placementByNode.get(id);
      if (!placement) continue;
      let lane = out.get(placement);
      if (!lane) out.set(placement, (lane = new Map()));
      const ids = lane.get(node.boardId);
      if (ids) ids.push(id);
      else lane.set(node.boardId, [id]);
    }
    return out;
  }, [nodes, nodeById, boards, placementByNode]);

  /** A card's children WITHIN one column — the mirror of the root rule above, so
   *  every task renders exactly once: a child that was promoted to a root of
   *  another board or another band must not also appear nested here. */
  const childrenInColumn = useCallback(
    (id: string, boardId: string, placement: TaskPlacement) =>
      nodes
        .filter(
          (n) =>
            n.parentId === id &&
            n.boardId === boardId &&
            placementByNode.get(n.id) === placement,
        )
        .sort(compareTaskOrder),
    [nodes, placementByNode],
  );

  /* ---- collapse state, remembered per project ---- */

  // Stored as a comma-joined list on the same localStorage-backed hook the view
  // toggle uses, so the server/hydration snapshot is "all expanded" (no
  // mismatch) and the remembered folds take over on the client.
  const [collapsedRaw, setCollapsedRaw] = useViewMode<string>(
    `boards-collapsed:${project.id}`,
    "",
  );
  const collapsed = useMemo(
    () => new Set(collapsedRaw.split(",").filter(Boolean) as TaskPlacement[]),
    [collapsedRaw],
  );
  const toggleCollapsed = (placement: TaskPlacement) => {
    const next = new Set(collapsed);
    if (next.has(placement)) next.delete(placement);
    else next.add(placement);
    setCollapsedRaw([...next].join(","));
  };

  /* ---- drops ---- */

  function handleReorderDrop(targetId: string) {
    if (dragBoardId && dragBoardId !== targetId) {
      const fromIdx = boards.findIndex((b) => b.id === dragBoardId);
      const targetIdx = boards.findIndex((b) => b.id === targetId);
      const ids = boards.map((b) => b.id).filter((id) => id !== dragBoardId);
      const to = ids.indexOf(targetId);
      // Dropping onto a target lands the board on that target's side: when
      // moving forward (dragged board started before the target) insert AFTER
      // it, otherwise insert in its place. Without the +1, forward drags (e.g.
      // 1st → 2nd) resolve to the unchanged order and appear to do nothing.
      const insertAt = to < 0 ? ids.length : fromIdx < targetIdx ? to + 1 : to;
      ids.splice(insertAt, 0, dragBoardId);
      reorderBoards(project.id, ids);
    }
    setDragBoardId(null);
    setOverBoardId(null);
  }

  const newBoardButton = (
    <button
      onClick={() => setCreating(true)}
      className="flex w-64 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-dashed border-border-strong px-3 py-2 text-sm text-muted transition-colors hover:border-accent hover:text-accent"
    >
      <span className="text-base leading-none">+</span> New board
    </button>
  );
  const boardModal = creating ? (
    <BoardModal mode="create" projectId={project.id} onClose={() => setCreating(false)} />
  ) : null;

  if (boards.length === 0) {
    return (
      <div className="flex items-start gap-4">
        <p className="text-sm text-faint">
          No boards yet. Add one to start organizing tasks.
        </p>
        {newBoardButton}
        {boardModal}
      </div>
    );
  }

  return (
    /* `-mx-8` cancels the page's gutter: the bands are rules that CUT the page,
       so stopping them short of the edge made the whole view read as a boxed
       card. The gutter comes back as padding INSIDE each row, so the first
       column still lines up with the page's text while the rest scrolls out
       under the edges. */
    <div className="-mx-8 flex flex-col gap-4">
      {PLACEMENT_ORDER.map((placement) => {
        const lane = byPlacement.get(placement) ?? new Map<string, TaskNode[]>();
        let count = 0;
        for (const cards of lane.values()) count += cards.length;
        const isCollapsed = collapsed.has(placement);
        return (
          <section key={placement}>
            <SeparatorHeader
              title={placementTitle(titles, placement)}
              count={count}
              bar={PLACEMENT_BAR[placement]}
              collapsed={isCollapsed}
              onToggle={() => toggleCollapsed(placement)}
              bleed
            />
            {isCollapsed ? null : (
              <div className="flex items-start gap-4 overflow-x-auto px-8 py-3">
                {boards.map((board) => (
                  <BoardColumn
                    key={board.id}
                    board={board}
                    placement={placement}
                    roots={lane.get(board.id) ?? []}
                    // A band nobody has filed anything into shows as a single
                    // slim row of board chips instead of a full row of empty
                    // 440px columns: the ladder has six bands and most of them
                    // are empty most of the time, so the page was mostly boxes
                    // containing nothing but "Add task". Still a drop target —
                    // an empty band you can't drop into is worse than an ugly one.
                    slim={count === 0}
                    // The tray is where Clear Done sends things, so it doesn't
                    // offer to clear itself.
                    doneIds={
                      placement === "doneThisWeek"
                        ? []
                        : (doneByPlacement.get(placement)?.get(board.id) ?? [])
                    }
                    onClearDone={(ids) => void fileTasks(ids, "doneThisWeek")}
                    doneTrayLabel={placementTitle(titles, "doneThisWeek")}
                    childrenInColumn={childrenInColumn}
                    label={placementTitle(titles, placement)}
                    taskMap={taskMap}
                    openTask={openTask}
                    onDropCard={(id) => void fileTask(id, board.id, placement)}
                    onDropCardAt={(dragId, targetId, pos) =>
                      void fileTask(dragId, board.id, placement, {
                        at: { targetId, pos, orderedIds: (lane.get(board.id) ?? []).map((n) => n.id) },
                      })
                    }
                    onAdd={(title) =>
                      addTask("backlog", title, board.id, placement)
                    }
                    isOver={overBoardId === board.id && dragBoardId !== board.id}
                    onReorderStart={() => setDragBoardId(board.id)}
                    onReorderEnd={() => {
                      setDragBoardId(null);
                      setOverBoardId(null);
                    }}
                    onReorderOver={() => setOverBoardId(board.id)}
                    onReorderDrop={() => handleReorderDrop(board.id)}
                  />
                ))}
                {/* Once, on the top band — six identical dashed buttons down a
                    page of mostly-empty bands was half of what made this view
                    read as noise. */}
                {placement === PLACEMENT_ORDER[0] ? newBoardButton : null}
              </div>
            )}
          </section>
        );
      })}
      {boardModal}
    </div>
  );
}


/**
 * One board's column INSIDE one bucket. The whole body is the card drop zone —
 * dropping anywhere in it files the card on this board and in this bucket.
 */
function BoardColumn({
  board,
  placement,
  roots,
  slim,
  doneIds,
  onClearDone,
  doneTrayLabel,
  childrenInColumn,
  label,
  taskMap,
  openTask,
  onDropCard,
  onDropCardAt,
  onAdd,
  isOver,
  onReorderStart,
  onReorderEnd,
  onReorderOver,
  onReorderDrop,
}: {
  board: Board;
  placement: TaskPlacement;
  roots: TaskNode[];
  /** Render as a one-line chip rather than a column — the whole band is empty. */
  slim: boolean;
  /** The done cards this column would sweep, at any depth — empty in the tray
   *  itself, and empty when there's nothing done here, which is what hides the
   *  button. */
  doneIds: string[];
  onClearDone: (ids: string[]) => void;
  /** What the tray is CALLED, for the confirm — it can be renamed on the canvas,
   *  and a dialog naming a band the user can't find is worse than no dialog. */
  doneTrayLabel: string;
  childrenInColumn: (
    id: string,
    boardId: string,
    placement: TaskPlacement,
  ) => TaskNode[];
  /** The bucket's name as the band above shows it — so the composer's hint says
   *  where the card will land in the words the canvas uses. */
  label: string;
  taskMap: ReturnType<typeof useWorkspace>["taskMap"];
  openTask: (id: string) => void;
  /** Dropped on the column itself — append to the end of this column. */
  onDropCard: (id: string) => void;
  /** Dropped ON a card — land next to that card instead of at the end. */
  onDropCardAt: (dragId: string, targetId: string, pos: "before" | "after") => void;
  onAdd: (title: string) => void;
  isOver: boolean;
  onReorderStart: () => void;
  onReorderEnd: () => void;
  onReorderOver: () => void;
  onReorderDrop: () => void;
}) {
  const [cardOver, setCardOver] = useState(false);
  // A card drop stops propagation, so this column's own `onDrop` never runs and
  // the ring would stay lit for good (TD2-201). See `useDragSessionEnd`.
  useDragSessionEnd(cardOver, () => setCardOver(false));
  // Cards ⇄ text, the same two views a canvas Section has (cards / outline). Per column and
  // session-only: it's a way of working on a list right now, not a property of
  // the board.
  const [text, setText_] = useState(false);

  /** This column as a task TREE — what text mode edits. Same shape the canvas
   *  builds for a Section (`useSectionUnits`): roots in rendered order, each with
   *  its in-column children beneath it. */
  const units = useMemo(() => {
    const build = (nodes: TaskNode[], depth: number): TaskUnit[] =>
      nodes.map((n) => {
        const t = taskMap[n.id];
        return {
          taskId: n.id,
          title: t?.title ?? "",
          description: t?.description ?? "",
          // Same depth cap as the card renderer, against a corrupt parent cycle.
          children: depth < 5 ? build(childrenInColumn(n.id, board.id, placement), depth + 1) : [],
        };
      });
    return build(roots, 0);
  }, [roots, taskMap, childrenInColumn, board.id, placement]);

  /** Every task this column owns, at any depth — the scope a save may delete
   *  within, and the order/parent baseline it compares against. */
  const scopeNodes = useMemo(() => {
    const out: TaskNode[] = [];
    const walk = (nodes: TaskNode[], depth: number) => {
      for (const n of nodes) {
        out.push(n);
        if (depth < 5) walk(childrenInColumn(n.id, board.id, placement), depth + 1);
      }
    };
    walk(roots, 0);
    return out;
  }, [roots, childrenInColumn, board.id, placement]);

  // A new root line lands on THIS board in THIS bucket — stated by name, since a
  // board view has no canvas mounted to resolve a pin from (the server owns that,
  // see `resolvePlacementSection`).
  const rootTarget = useMemo(() => ({ placement }), [placement]);
  const outline = useOutlineDraft({
    active: text,
    units,
    scopeNodes,
    boardId: board.id,
    rootTarget,
    // Escape leaves text mode; the hook has already flushed by then.
    onLeave: () => setText_(false),
  });
  const showCards = () => {
    if (!text) return;
    void outline.flush();
    setText_(false);
  };
  const showText = () => {
    if (text) return;
    outline.seed();
    setText_(true);
  };

  // A card plus its subtasks nested beneath it — the canvas's shape, so a parent
  // and its children read as one unit. Depth-capped against a corrupt parent
  // cycle, which would otherwise recurse forever.
  const renderCard = (node: TaskNode, depth: number) => {
    const task = taskMap[node.id];
    if (!task) return null;
    const kids =
      depth < 5 ? childrenInColumn(node.id, board.id, placement) : [];
    return (
      <TaskCard
        key={node.id}
        task={task}
        statusBadge
        onOpen={() => openTask(node.id)}
        // Roots only: they ARE this column's run, which is what the drop math
        // reorders. A nested subtask isn't in that run, so it stays inert and the
        // drop falls through to the column (append).
        onDropAt={
          depth === 0
            ? (dragId, pos) => onDropCardAt(dragId, node.id, pos)
            : undefined
        }
      >
        {kids.map((k) => renderCard(k, depth + 1))}
      </TaskCard>
    );
  };

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(BOARD_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onReorderOver();
        } else if (e.dataTransfer.types.includes(TASK_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!cardOver) setCardOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only when the pointer really leaves the column: dragging across a
        // child card fires dragleave on the way past, and reacting to that makes
        // the highlight strobe.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setCardOver(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(BOARD_DND_MIME)) {
          e.preventDefault();
          onReorderDrop();
          return;
        }
        if (e.dataTransfer.types.includes(TASK_DND_MIME)) {
          e.preventDefault();
          setCardOver(false);
          const id = e.dataTransfer.getData(TASK_DND_MIME);
          if (id) onDropCard(id);
        }
      }}
      className={[
        "flex shrink-0 flex-col rounded-xl border bg-surface-2 transition-colors",
        // Three widths, one rule: a column with cards is full width, one whose
        // band has cards elsewhere shrinks to a stub you can still aim at, and a
        // column in an entirely empty band is a single-line chip.
        slim ? "w-44" : roots.length === 0 ? "w-56" : "w-[440px]",
        isOver || cardOver ? "border-accent ring-1 ring-accent" : "border-border",
      ].join(" ")}
    >
      {/* header — the only row a slim chip has */}
      <div
        className={[
          "flex items-center gap-2 px-3 py-2",
          slim ? "" : "border-b border-border",
        ].join(" ")}
      >
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(BOARD_DND_MIME, board.id);
            onReorderStart();
          }}
          onDragEnd={onReorderEnd}
          className="cursor-grab text-faint hover:text-fg active:cursor-grabbing"
          title="Drag to reorder board"
          aria-label="Reorder board"
        >
          <GripVertical aria-hidden size={13} strokeWidth={1.75} />
        </span>
        <Avatar name={board.name} size={18} imageUrl={board.image} color={board.color} />
        <Link
          href={`/boards/${board.id}`}
          className="truncate text-sm font-semibold tracking-tight text-fg hover:text-accent"
        >
          {board.name}
        </Link>
        <span className="nums text-xs text-faint">{roots.length}</span>
        {slim ? null : (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
            <ViewBtn active={text} onClick={showText} title="Text">
              <AlignJustify aria-hidden size={14} strokeWidth={1.75} />
            </ViewBtn>
            <ViewBtn active={!text} onClick={showCards} title="Cards">
              <LayoutGrid aria-hidden size={14} strokeWidth={1.75} />
            </ViewBtn>
            {outline.saving ? (
              <span
                aria-label="Saving"
                className="ml-1 h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-faint border-t-transparent"
              />
            ) : null}
          </div>
        )}
        {doneIds.length > 0 ? (
          <button
            onClick={() => {
              const n = doneIds.length;
              if (
                !confirm(
                  `Clear ${n} done task${n === 1 ? "" : "s"} out of ${label} · ${board.name}?\n\n` +
                    `${n === 1 ? "It moves" : "They move"} to ${doneTrayLabel}. ` +
                    `Still on the board, still done — nothing is archived, deleted, or ` +
                    `changed in status.`,
                )
              )
                return;
              onClearDone(doneIds);
            }}
            title={`Move this column's ${doneIds.length} done card${doneIds.length === 1 ? "" : "s"} to ${doneTrayLabel}`}
            className="ml-auto shrink-0 rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            Clear Done ({doneIds.length})
          </button>
        ) : null}
      </div>

      {/* The body, in whichever view is on. Both use the canvas Section's own
          metrics — `p-2` around the list and `space-y-1.5` between cards — so a
          column and a Section read as the same list rather than two dialects. */}
      {slim ? null : (
        <div className="p-2">
          {text ? (
            <OutlineEditor
              rows={outline.rows}
              inputRefs={outline.inputRefs}
              descCapped
              onText={outline.setText}
              onKeyDown={outline.onRowKeyDown}
            />
          ) : (
            <div className="min-h-16 space-y-1.5">
              {roots.map((node) => renderCard(node, 0))}
              <AddCard label={label} onAdd={onAdd} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One of the two view buttons in a column header — same look as the canvas
 *  Section's, so the cards/outline pair reads identically on both surfaces. */
function ViewBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={[
        "cursor-pointer rounded px-1.5 py-0.5 text-xs leading-none transition-colors",
        active ? "bg-surface-3 text-fg" : "text-faint hover:text-fg",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function AddCard({
  label,
  onAdd,
}: {
  label: string;
  onAdd: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-faint hover:bg-surface-3 hover:text-muted"
      >
        <span className="text-sm leading-none">+</span> Add task
      </button>
    );
  }

  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && text.trim()) {
          onAdd(text.trim());
          setText(""); // keep open for rapid entry
        } else if (e.key === "Escape") {
          setText("");
          setEditing(false);
        }
      }}
      onBlur={() => {
        if (!text.trim()) setEditing(false);
      }}
      placeholder={`Task name, then Enter… (lands in ${label})`}
      className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
    />
  );
}
