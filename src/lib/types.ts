/*
  Types for To-do Challenger — a lightweight, ClickUp-style task manager.
  These keep the mock data honest and self-documenting. They're a starting
  shape, not a schema lock — swap the mock store for a real API later.
*/

export type Priority = "urgent" | "high" | "normal" | "low";

/** ClickUp-style workflow statuses (the List view groups by these). */
export type TaskStatus = "backlog" | "planned" | "in-progress" | "done";

/** A colored label chip, ClickUp-style. */
export type TagTone = "purple" | "blue" | "green" | "amber" | "pink" | "gray";

export interface Tag {
  id: string;
  label: string;
  tone: TagTone;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority?: Priority;
  /** Display name of the person the task is assigned to. */
  assignee?: string;
  /** ISO date the task is due — drives the Due column (overdue shows red). */
  dueDate?: string;
  /** Tag ids (see TAGS in mock-data). */
  tags?: string[];
  /** Free-text notes shown in the detail modal. */
  description?: string;
  /** Comment count, shown as "💬 N" on the row. */
  commentCount?: number;
  /** ISO timestamp of last update — drives the "Updated" column. */
  updatedAt?: string;
  /** Nested sub-tasks, revealed when the row is expanded. */
  subtasks?: Task[];
}

/** One entry in a task's activity log (shown in the detail modal). */
export interface TaskLogEntry {
  id: string;
  at: string; // ISO
  kind:
    | "created"
    | "status"
    | "moved"
    | "nested"
    | "started"
    | "paused"
    | "done"
    | "reopened";
  message: string;
}
