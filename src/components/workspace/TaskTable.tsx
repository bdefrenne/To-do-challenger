"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { Project, TaskStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_ORDER, STATUS_TONE } from "@/lib/statuses";
import { allBoards } from "@/lib/boards";
import { isAssignedTo, makeNodeMatcher, makeTaskPredicate } from "@/lib/task-filters";
import { useAssignOnCreate } from "./useAssignOnCreate";
import { useWorkspace, type TaskNode } from "./WorkspaceContext";
import { TaskTableRow, GRID } from "./TaskTableRow";
import type { BoardGroup } from "./BoardPill";

/**
 * ClickUp-style task table: grouped by status, collapsible, drag-and-drop.
 *
 * With no props it shows every top-level task (the global "All tasks" view).
 * Scope it to a project or board with `boardIds`; `addBoardId` is the board
 * that inline-added tasks land on (null = unassigned). Every row shows its
 * board as a clickable pill (change within the same project; assign to any
 * project when the task has no board).
 *
 * `assigneeId` narrows it to one person (TD2-216) on the same rule the canvas
 * uses: a branch survives if anything in it matches, and a parent kept only
 * because a subtask matched is dimmed. A board filter needs nothing here —
 * `boardIds` IS the board scope, so the caller just passes fewer.
 */
export function TaskTable({
  boardIds,
  addBoardId = null,
  assigneeId = null,
}: {
  boardIds?: string[];
  addBoardId?: string | null;
  /** Show only this person's work, or null for everyone. */
  assigneeId?: string | null;
} = {}) {
  const {
    nodes,
    taskMap,
    projects,
    childrenOf,
    openTask,
    toggleDone,
    setStatus,
    editTask,
    openProjectSettings,
    moveNode,
    dropToGroup,
    moveToBoard,
    addTask,
  } = useWorkspace();

  /* The three lookups below answer "what is the board with this id called /
     coloured / in?", so they read HIDDEN boards too (TD2-213): a task on a
     board that's been put away can still be on screen — the board's own page, a
     search, the Archived view — and tagging it "No board" would read as the
     task having lost its board rather than the board having been put away.
     `toGroup`, just below, is the opposite question (which boards may a task be
     moved ONTO?) and deliberately offers only the visible ones. */
  const boardNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of projects) for (const b of allBoards(p)) m[b.id] = b.name;
    return m;
  }, [projects]);

  // boardId → its project, so a row can offer sibling boards (same project).
  const projectByBoardId = useMemo(() => {
    const m: Record<string, Project> = {};
    for (const p of projects) for (const b of allBoards(p)) m[b.id] = p;
    return m;
  }, [projects]);

  // boardId → its accent color, falling back to the project's color.
  const boardColorById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of projects)
      for (const b of allBoards(p))
        m[b.id] = b.color || p.color || "#7b68ee";
    return m;
  }, [projects]);

  // Where a task may be MOVED — the live boards only, so the picker never
  // offers to file work onto a board nobody is looking at.
  const toGroup = (p: Project): BoardGroup => ({
    projectId: p.id,
    projectName: p.name,
    boards: (p.boards ?? []).map((b) => ({ id: b.id, name: b.name })),
  });

  // Boards a task may move to: its own project when it has a board, else every
  // project (two-step assign for unassigned tasks).
  const boardGroupsFor = (boardId: string | null): BoardGroup[] => {
    const proj = boardId ? projectByBoardId[boardId] : undefined;
    return proj ? [toGroup(proj)] : projects.map(toGroup);
  };

  const inScope = (n: TaskNode) =>
    !boardIds || (n.boardId != null && boardIds.includes(n.boardId));

  /* Whose work to draw. Memoized across the whole render, not per row: the
     matcher walks a subtree to answer, and every row asks about its own
     children right after its parent asked about it. */
  const matchesAssignee = useMemo(
    () =>
      makeNodeMatcher<TaskNode>({
        keep: makeTaskPredicate({ assigneeId }),
        taskOf: (id) => taskMap[id],
        childrenOf,
      }),
    [assigneeId, taskMap, childrenOf],
  );

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [collapsedRows, setCollapsedRows] = useState<Record<string, boolean>>({});

  function renderRow(node: TaskNode, depth: number): React.ReactNode {
    const task = taskMap[node.id];
    if (!task) return null;
    const kids = childrenOf(node.id).filter((k) => matchesAssignee(k.id));
    const hasChildren = kids.length > 0;
    const expanded = !collapsedRows[node.id];
    // Scope the assign picker to the task's project members (mirrors the card).
    const taskProject = task.projectId
      ? projects.find((p) => p.id === task.projectId)
      : undefined;
    return (
      <div key={node.id}>
        <TaskTableRow
          node={node}
          task={task}
          depth={depth}
          hasChildren={hasChildren}
          expanded={expanded}
          draggingId={draggingId}
          currentBoardId={node.boardId}
          currentBoardName={node.boardId ? boardNameById[node.boardId] ?? null : null}
          boardColor={node.boardId ? boardColorById[node.boardId] ?? null : null}
          boardGroups={boardGroupsFor(node.boardId)}
          onChangeBoard={(bid) => moveToBoard(node.id, bid)}
          onToggleExpand={() =>
            setCollapsedRows((p) => ({ ...p, [node.id]: !p[node.id] }))
          }
          onOpen={() => openTask(node.id)}
          onToggleDone={() => toggleDone(node.id)}
          onSetStatus={(s) => setStatus(node.id, s)}
          onImportance={(v) => editTask(node.id, { importance: v })}
          onAssign={(id, patch) => editTask(id, patch)}
          memberIds={taskProject?.members}
          onEditMembers={
            taskProject ? () => openProjectSettings(taskProject.id) : undefined
          }
          // Context only — nothing on this row is theirs, it's here because
          // something below it is.
          dimmed={!!assigneeId && !isAssignedTo(task, assigneeId)}
          onDragStartRow={setDraggingId}
          onDropRow={(targetId, pos) => {
            if (draggingId) moveNode(draggingId, targetId, pos);
            setDraggingId(null); // dragend may not fire if the row remounts
          }}
        />
        {hasChildren && expanded
          ? kids.map((k) => renderRow(k, depth + 1))
          : null}
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm"
      onDragEnd={() => setDraggingId(null)}
    >
      <div className="min-w-[704px]">
        {/* column header */}
        <div
          className={`${GRID} border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-faint`}
        >
          <div>Name</div>
          <div className="text-center">Assignees</div>
          <div>Status</div>
          <div>Due</div>
          <div>Updated</div>
        </div>

        {STATUS_ORDER.map((status) => {
          const groupTop = nodes.filter(
            (n) =>
              n.parentId === null &&
              n.status === status &&
              inScope(n) &&
              matchesAssignee(n.id),
          );
          const collapsed = collapsedGroups[status];
          return (
            <div key={status}>
              <GroupHeader
                status={status}
                count={groupTop.length}
                collapsed={collapsed}
                onToggle={() =>
                  setCollapsedGroups((p) => ({ ...p, [status]: !p[status] }))
                }
                onDropInto={() => {
                  if (draggingId) dropToGroup(draggingId, status);
                  setDraggingId(null);
                }}
                draggingActive={!!draggingId}
              />
              {!collapsed ? (
                <>
                  {groupTop.length === 0 ? (
                    <div
                      className="border-b border-border px-3 py-2.5 pl-12 text-xs text-faint"
                      onDragOver={(e) => draggingId && e.preventDefault()}
                      onDrop={() => {
                        if (draggingId) dropToGroup(draggingId, status);
                        setDraggingId(null);
                      }}
                    >
                      Drop a task here
                    </div>
                  ) : (
                    groupTop.map((n) => renderRow(n, 0))
                  )}
                  <AddTaskRow
                    assigneeId={assigneeId}
                    onAdd={(title, assigneeIds) =>
                      addTask(status, title, addBoardId, undefined, assigneeIds)
                    }
                  />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GroupHeader({
  status,
  count,
  collapsed,
  onToggle,
  onDropInto,
  draggingActive,
}: {
  status: TaskStatus;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onDropInto: () => void;
  draggingActive: boolean;
}) {
  const tone = STATUS_TONE[status];
  return (
    <div
      className="flex items-center gap-2 bg-surface-2 px-3 py-2"
      onDragOver={(e) => draggingActive && e.preventDefault()}
      onDrop={onDropInto}
    >
      <button onClick={onToggle} className="text-faint hover:text-fg" aria-label="Toggle group">
        {collapsed ? (
          <ChevronRight aria-hidden size={14} strokeWidth={2} />
        ) : (
          <ChevronDown aria-hidden size={14} strokeWidth={2} />
        )}
      </button>
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${tone.bg} ${tone.text} ${tone.border}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
        {STATUS_LABEL[status]}
      </span>
      <span className="nums text-xs text-faint">{count}</span>
    </div>
  );
}

function AddTaskRow({
  onAdd,
  assigneeId,
}: {
  onAdd: (title: string, assigneeIds?: string[]) => void;
  /** The assignee filter in force — see `useAssignOnCreate` (TD2-193). */
  assigneeId: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const assign = useAssignOnCreate(assigneeId);

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex w-full items-center gap-2 border-b border-border px-3 py-2 pl-12 text-left text-xs text-faint hover:bg-surface-2 hover:text-muted"
      >
        <span className="text-sm leading-none">+</span> Add task
      </button>
    );
  }

  return (
    <div className="border-b border-border px-3 py-1.5 pl-12">
      <div className="flex items-center gap-2">
      <span className="text-sm leading-none text-faint">+</span>
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            onAdd(text.trim(), assign.assigneeIds);
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
        className="flex-1 bg-transparent py-1 text-sm text-fg outline-none placeholder:text-faint"
      />
      </div>
      {assign.control}
    </div>
  );
}
