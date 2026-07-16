"use client";

import { useState } from "react";
import type { TaskStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_ORDER, STATUS_TONE } from "@/lib/statuses";
import { useWorkspace } from "./WorkspaceContext";
import { TaskCard, TASK_DND_MIME } from "./TaskCard";

/**
 * A Trello-style board for ONE board id: the four shared statuses as columns.
 * Cards are the board's top-level tasks; drag a card into another column (here
 * or on another board) to move it via `moveToBoard`.
 */
export function KanbanBoard({ boardId }: { boardId: string }) {
  const { nodes, taskMap, openTask, moveToBoard, addTask } = useWorkspace();

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {STATUS_ORDER.map((status) => {
        const cards = nodes
          .filter(
            (n) => n.boardId === boardId && n.parentId === null && n.status === status,
          )
          .sort((a, b) => a.position - b.position);
        return (
          <KanbanColumn
            key={status}
            status={status}
            count={cards.length}
            onDropCard={(id) => moveToBoard(id, boardId, status)}
            onAdd={(title) => addTask(status, title, boardId)}
          >
            {cards.map((n) => {
              const task = taskMap[n.id];
              return task ? (
                <TaskCard key={n.id} task={task} onOpen={() => openTask(n.id)} />
              ) : null;
            })}
          </KanbanColumn>
        );
      })}
    </div>
  );
}

function KanbanColumn({
  status,
  count,
  onDropCard,
  onAdd,
  children,
}: {
  status: TaskStatus;
  count: number;
  onDropCard: (id: string) => void;
  onAdd: (title: string) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const tone = STATUS_TONE[status];

  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${tone.bg} ${tone.text} ${tone.border}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
          {STATUS_LABEL[status]}
        </span>
        <span className="nums text-xs text-faint">{count}</span>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!over) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const id = e.dataTransfer.getData(TASK_DND_MIME);
          if (id) onDropCard(id);
        }}
        className={[
          "flex min-h-24 flex-1 flex-col gap-2 rounded-xl border p-2 transition-colors",
          over ? "border-accent bg-accent-soft/40" : "border-border bg-surface-2",
        ].join(" ")}
      >
        {children}
        <AddCard onAdd={onAdd} />
      </div>
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
