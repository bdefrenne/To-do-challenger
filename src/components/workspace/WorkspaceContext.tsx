"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TASKS, DEFAULT_ASSIGNEE } from "@/lib/mock-data";
import { STATUS_LABEL } from "@/lib/statuses";
import type { Task, TaskStatus, TaskLogEntry } from "@/lib/types";

/** Position of a drop relative to the target row. */
export type DropPos = "before" | "after" | "inside";

/** Ordered tree node: array order = display order; parentId = nesting.
 *  We track when it entered its current status (for "Nd in <status>"). */
export interface TaskNode {
  id: string;
  parentId: string | null;
  status: TaskStatus;
  statusSince: string; // ISO — when it entered the current status
}

interface WorkspaceContextValue {
  nodes: TaskNode[];
  taskMap: Record<string, Task>;
  logs: Record<string, TaskLogEntry[]>;
  openTaskId: string | null;
  openTask: (id: string) => void;
  closeTask: () => void;
  childrenOf: (id: string | null) => TaskNode[];
  nodeById: (id: string) => TaskNode | undefined;
  start: (id: string) => void; // move to In progress
  toggleDone: (id: string) => void;
  setStatus: (id: string, status: TaskStatus) => void;
  moveNode: (dragId: string, targetId: string, pos: DropPos) => void;
  dropToGroup: (dragId: string, status: TaskStatus) => void;
  addTask: (status: TaskStatus, title: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

let seedSeq = 0;
function seedLog(task: Task): TaskLogEntry[] {
  const base = task.updatedAt ?? "2026-07-10T10:00:00+02:00";
  const created = new Date(new Date(base).getTime() - 2 * 86_400_000).toISOString();
  const out: TaskLogEntry[] = [
    { id: `seed-${seedSeq++}`, at: created, kind: "created", message: "Task created" },
  ];
  if (task.status === "planned") {
    out.push({ id: `seed-${seedSeq++}`, at: base, kind: "moved", message: "Moved to Planned" });
  } else if (task.status === "in-progress") {
    out.push({ id: `seed-${seedSeq++}`, at: base, kind: "started", message: "Started" });
  } else if (task.status === "done") {
    out.push({ id: `seed-${seedSeq++}`, at: base, kind: "done", message: "Completed" });
  }
  return out;
}

function buildInitial() {
  const nodes: TaskNode[] = [];
  const taskMap: Record<string, Task> = {};
  const logs: Record<string, TaskLogEntry[]> = {};
  const add = (t: Task, parentId: string | null) => {
    taskMap[t.id] = t;
    logs[t.id] = seedLog(t);
    nodes.push({
      id: t.id,
      parentId,
      status: t.status,
      statusSince: t.updatedAt ?? "2026-07-10T10:00:00+02:00",
    });
  };
  for (const t of TASKS) {
    add(t, null);
    for (const s of t.subtasks ?? []) add(s, t.id);
  }
  return { nodes, taskMap, logs };
}

function isDescendant(nodes: TaskNode[], ancestorId: string, nodeId: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur = byId.get(nodeId);
  while (cur?.parentId) {
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

function appendToGroup(arr: TaskNode[], node: TaskNode): TaskNode[] {
  let insertAt = arr.length;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].parentId === null && arr[i].status === node.status) {
      insertAt = i + 1;
      break;
    }
  }
  const next = [...arr];
  next.splice(insertAt, 0, node);
  return next;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(buildInitial, []);
  const [nodes, setNodes] = useState<TaskNode[]>(initial.nodes);
  const [taskMap, setTaskMap] = useState<Record<string, Task>>(initial.taskMap);
  const [logs, setLogs] = useState<Record<string, TaskLogEntry[]>>(initial.logs);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const newCount = useRef(0);
  const logCount = useRef(0);

  function appendLog(taskId: string, kind: TaskLogEntry["kind"], message: string) {
    const entry: TaskLogEntry = {
      id: `log-${++logCount.current}`,
      at: new Date().toISOString(),
      kind,
      message,
    };
    setLogs((prev) => ({ ...prev, [taskId]: [...(prev[taskId] ?? []), entry] }));
  }

  /** Apply a status change to one node, stamping statusSince. */
  function applyStatus(id: string, status: TaskStatus) {
    const now = new Date().toISOString();
    setNodes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, status, statusSince: now } : n)),
    );
  }

  function start(id: string) {
    if (nodes.find((n) => n.id === id)?.status === "in-progress") return;
    applyStatus(id, "in-progress");
    appendLog(id, "started", "Started");
  }

  function toggleDone(id: string) {
    const nowDone = nodes.find((n) => n.id === id)?.status !== "done";
    applyStatus(id, nowDone ? "done" : "planned");
    appendLog(id, nowDone ? "done" : "reopened", nowDone ? "Completed" : "Reopened (Planned)");
  }

  function setStatus(id: string, status: TaskStatus) {
    const from = nodes.find((n) => n.id === id)?.status;
    if (from === status) return;
    applyStatus(id, status);
    appendLog(id, "status", `Status: ${from ? STATUS_LABEL[from] : "?"} → ${STATUS_LABEL[status]}`);
  }

  function moveNode(dragId: string, targetId: string, pos: DropPos) {
    if (dragId === targetId) return;
    if (isDescendant(nodes, dragId, targetId)) return;
    const drag = nodes.find((n) => n.id === dragId);
    const target = nodes.find((n) => n.id === targetId);
    if (!drag || !target) return;
    const statusChanged = pos !== "inside" && drag.status !== target.status;
    const now = new Date().toISOString();

    setNodes((prev) => {
      const arr = prev.filter((n) => n.id !== dragId);
      const moved = { ...drag };
      const ti = arr.findIndex((n) => n.id === targetId);
      if (pos === "inside") {
        moved.parentId = target.id;
        arr.splice(ti + 1, 0, moved);
      } else {
        moved.parentId = target.parentId;
        if (statusChanged) {
          moved.status = target.status;
          moved.statusSince = now;
        }
        arr.splice(pos === "before" ? ti : ti + 1, 0, moved);
      }
      return arr;
    });

    if (pos === "inside") {
      appendLog(dragId, "nested", `Nested under “${taskMap[targetId]?.title ?? "task"}”`);
    } else if (statusChanged) {
      appendLog(dragId, "moved", `Moved to ${STATUS_LABEL[target.status]}`);
    } else {
      appendLog(dragId, "moved", `Reordered in ${STATUS_LABEL[target.status]}`);
    }
  }

  function dropToGroup(dragId: string, status: TaskStatus) {
    const from = nodes.find((n) => n.id === dragId)?.status;
    const now = new Date().toISOString();
    setNodes((prev) => {
      const di = prev.findIndex((n) => n.id === dragId);
      if (di < 0) return prev;
      const arr = prev.filter((n) => n.id !== dragId);
      const changed = from !== status;
      return appendToGroup(arr, {
        ...prev[di],
        parentId: null,
        status,
        statusSince: changed ? now : prev[di].statusSince,
      });
    });
    if (from !== status) appendLog(dragId, "moved", `Moved to ${STATUS_LABEL[status]}`);
  }

  function addTask(status: TaskStatus, title: string) {
    const id = `t-new-${++newCount.current}`;
    const now = new Date().toISOString();
    const task: Task = {
      id,
      title,
      status,
      priority: "normal",
      assignee: DEFAULT_ASSIGNEE,
      updatedAt: now,
    };
    setTaskMap((prev) => ({ ...prev, [id]: task }));
    setNodes((prev) => appendToGroup(prev, { id, parentId: null, status, statusSince: now }));
    setLogs((prev) => ({
      ...prev,
      [id]: [
        { id: `log-${++logCount.current}`, at: now, kind: "created", message: `Created in ${STATUS_LABEL[status]}` },
      ],
    }));
  }

  const childrenOf = (id: string | null) => nodes.filter((n) => n.parentId === id);
  const nodeById = (id: string) => nodes.find((n) => n.id === id);

  return (
    <WorkspaceContext.Provider
      value={{
        nodes,
        taskMap,
        logs,
        openTaskId,
        openTask: setOpenTaskId,
        closeTask: () => setOpenTaskId(null),
        childrenOf,
        nodeById,
        start,
        toggleDone,
        setStatus,
        moveNode,
        dropToGroup,
        addTask,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within <WorkspaceProvider>");
  return ctx;
}
