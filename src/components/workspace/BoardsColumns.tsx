"use client";

import { useState } from "react";
import Link from "next/link";
import type { Board, Project, TaskStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_ORDER, STATUS_TONE } from "@/lib/statuses";
import { useWorkspace, type TaskNode } from "./WorkspaceContext";
import { TaskCard, TASK_DND_MIME } from "./TaskCard";
import { BoardModal } from "./BoardModal";
import { Avatar } from "@/components/ui/Badge";

/** DnD payload type for dragging a whole board column (distinct from task
 *  cards, which use TASK_DND_MIME, so the two drag surfaces never collide). */
const BOARD_DND_MIME = "application/x-board-id";

/**
 * A project's Boards view: one COLUMN PER BOARD (left→right in board order),
 * each column listing that board's tasks split by small status dividers.
 * Drag a card onto a status divider to move it (board + status); drag a
 * column by its handle to reorder the boards (which also reorders the
 * sidebar, since both read the persisted board position).
 */
export function BoardsColumns({ project }: { project: Project }) {
  const {
    nodes,
    taskMap,
    openTask,
    moveToBoard,
    addTask,
    deleteBoard,
    reorderBoards,
  } = useWorkspace();
  const boards = project.boards ?? [];

  const [dragBoardId, setDragBoardId] = useState<string | null>(null);
  const [overBoardId, setOverBoardId] = useState<string | null>(null);
  const [modal, setModal] = useState<
    { mode: "create" } | { mode: "edit"; board: Board } | null
  >(null);

  function handleReorderDrop(targetId: string) {
    if (dragBoardId && dragBoardId !== targetId) {
      const ids = boards.map((b) => b.id).filter((id) => id !== dragBoardId);
      const to = ids.indexOf(targetId);
      ids.splice(to < 0 ? ids.length : to, 0, dragBoardId);
      reorderBoards(project.id, ids);
    }
    setDragBoardId(null);
    setOverBoardId(null);
  }

  return (
    <div className="flex items-start gap-4 overflow-x-auto pb-2">
      {boards.length === 0 ? (
        <p className="text-sm text-faint">
          No boards yet. Add one to start organizing tasks.
        </p>
      ) : (
        boards.map((board) => (
          <BoardColumn
            key={board.id}
            board={board}
            nodes={nodes}
            taskMap={taskMap}
            openTask={openTask}
            onDropCard={(id, status) => moveToBoard(id, board.id, status)}
            onAdd={(title) => addTask("backlog", title, board.id)}
            onEdit={() => setModal({ mode: "edit", board })}
            onDelete={() => {
              if (confirm(`Delete board “${board.name}” and its tasks?`))
                deleteBoard(board.id);
            }}
            isOver={overBoardId === board.id && dragBoardId !== board.id}
            onReorderStart={() => setDragBoardId(board.id)}
            onReorderEnd={() => {
              setDragBoardId(null);
              setOverBoardId(null);
            }}
            onReorderOver={() => setOverBoardId(board.id)}
            onReorderDrop={() => handleReorderDrop(board.id)}
          />
        ))
      )}
      <button
        onClick={() => setModal({ mode: "create" })}
        className="flex w-64 shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-border-strong px-3 py-2 text-sm text-muted transition-colors hover:border-accent hover:text-accent"
      >
        <span className="text-base leading-none">+</span> New board
      </button>

      {modal ? (
        <BoardModal
          mode={modal.mode}
          projectId={project.id}
          board={modal.mode === "edit" ? modal.board : undefined}
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  );
}

function BoardColumn({
  board,
  nodes,
  taskMap,
  openTask,
  onDropCard,
  onAdd,
  onEdit,
  onDelete,
  isOver,
  onReorderStart,
  onReorderEnd,
  onReorderOver,
  onReorderDrop,
}: {
  board: Board;
  nodes: TaskNode[];
  taskMap: ReturnType<typeof useWorkspace>["taskMap"];
  openTask: (id: string) => void;
  onDropCard: (id: string, status: TaskStatus) => void;
  onAdd: (title: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  isOver: boolean;
  onReorderStart: () => void;
  onReorderEnd: () => void;
  onReorderOver: () => void;
  onReorderDrop: () => void;
}) {
  const count = nodes.filter((n) => n.boardId === board.id).length;

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(BOARD_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onReorderOver();
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(BOARD_DND_MIME)) {
          e.preventDefault();
          onReorderDrop();
        }
      }}
      className={[
        "flex w-80 shrink-0 flex-col rounded-xl border bg-surface-2 transition-colors",
        isOver ? "border-accent ring-1 ring-accent" : "border-border",
      ].join(" ")}
    >
      {/* header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
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
          ⠿
        </span>
        <Avatar name={board.name} size={18} imageUrl={board.image} color={board.color} />
        <Link
          href={`/boards/${board.id}`}
          className="truncate text-sm font-semibold tracking-tight text-fg hover:text-accent"
        >
          {board.name}
        </Link>
        <span className="nums text-xs text-faint">{count}</span>
        <button
          onClick={onEdit}
          className="ml-auto rounded-md px-2 py-0.5 text-xs text-faint transition-colors hover:bg-surface-3 hover:text-fg"
        >
          Edit
        </button>
        <button
          onClick={onDelete}
          className="rounded-md px-2 py-0.5 text-xs text-faint transition-colors hover:bg-nerf-soft hover:text-nerf"
        >
          Delete
        </button>
      </div>

      {/* status-divided task list */}
      <div className="flex flex-col gap-1 p-2">
        {STATUS_ORDER.map((status) => {
          const cards = nodes
            .filter(
              (n) =>
                n.boardId === board.id &&
                n.parentId === null &&
                n.status === status,
            )
            .sort((a, b) => a.position - b.position);
          return (
            <StatusSection
              key={status}
              status={status}
              count={cards.length}
              onDropCard={(id) => onDropCard(id, status)}
            >
              {cards.map((n) => {
                const task = taskMap[n.id];
                return task ? (
                  <TaskCard key={n.id} task={task} onOpen={() => openTask(n.id)} />
                ) : null;
              })}
            </StatusSection>
          );
        })}
        <AddCard onAdd={onAdd} />
      </div>
    </div>
  );
}

/** One status band inside a board column: a small divider + a drop zone for
 *  its cards. Dropping a card here moves it to this board + status. */
function StatusSection({
  status,
  count,
  onDropCard,
  children,
}: {
  status: TaskStatus;
  count: number;
  onDropCard: (id: string) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const tone = STATUS_TONE[status];
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TASK_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!over) setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(TASK_DND_MIME)) {
          e.preventDefault();
          setOver(false);
          const id = e.dataTransfer.getData(TASK_DND_MIME);
          if (id) onDropCard(id);
        }
      }}
      className={[
        "flex flex-col gap-2 rounded-lg p-1 transition-colors",
        over ? "bg-accent-soft/40 ring-1 ring-accent" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-1.5 px-1 pt-1">
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
        <span className={`text-[11px] font-bold uppercase tracking-wide ${tone.text}`}>
          {STATUS_LABEL[status]}
        </span>
        <span className="nums text-[11px] text-faint">{count}</span>
      </div>
      {children}
    </div>
  );
}

function AddCard({ onAdd }: { onAdd: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-faint hover:bg-surface-3 hover:text-muted"
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
      placeholder="Task name, then Enter…"
      className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
    />
  );
}

