/*
  Types for To-do Challenger — a lightweight, ClickUp-style task manager.
  These keep the mock data honest and self-documenting. They're a starting
  shape, not a schema lock — swap the mock store for a real API later.
*/

/** ClickUp-style workflow statuses (the List view groups by these). */
export type TaskStatus = "backlog" | "planned" | "in-progress" | "done";

/** How often a task repeats. */
export type Recurrence = "none" | "daily" | "weekly" | "monthly";

/**
 * Fibonacci points, story-point style. Used for both `value` (payoff) and
 * `difficulty` (effort) — multiply them for a rough "challenge score".
 */
export type FibPoints = 1 | 2 | 3 | 5 | 8;

/** An open-ended, user-defined field value (the custom-field bag). */
export type CustomFieldValue = string | number | boolean;

/** A colored label chip, ClickUp-style. */
export type TagTone = "purple" | "blue" | "green" | "amber" | "pink" | "gray";

export interface Tag {
  id: string;
  label: string;
  tone: TagTone;
}

/** One Trello-style board — the sub level of the hierarchy. */
export interface Board {
  id: string;
  projectId: string;
  name: string;
}

/** Top level of the hierarchy (e.g. a whole game); holds Boards. */
export interface Project {
  id: string;
  name: string;
  boards?: Board[];
}

/** An image attached to a task (bytes stored in Vercel Blob). */
export interface Attachment {
  id: string;
  /** Original file name, e.g. "screenshot.png". */
  filename: string;
  /** MIME type, e.g. "image/png". */
  mimeType: string;
  /** Size in bytes. */
  size: number;
  /** Public URL — used directly as an <img src>. */
  url: string;
  /** ISO timestamp the attachment was added. */
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** Which board the task lives on (null/undefined = unassigned). */
  boardId?: string | null;
  /** Display names of the people assigned (empty/undefined = unassigned). */
  assignees?: string[];
  /** ISO date work should start — pairs with dueDate (the end). */
  startDate?: string;
  /** ISO date the task is due — drives the Due column (overdue shows red). */
  dueDate?: string;
  /** Tag ids (see TAGS in mock-data). */
  tags?: string[];
  /** How often the task repeats. Defaults to "none". */
  recurrence?: Recurrence;
  /** Ids of tasks this one is blocked by (they must finish first). */
  dependsOn?: string[];
  /** User-defined fields, keyed by name (the ClickUp custom-field bag). */
  customFields?: Record<string, CustomFieldValue>;
  /** Payoff points (Fibonacci) — the "value" axis. */
  value?: FibPoints;
  /** Effort points (Fibonacci) — the "difficulty" axis. */
  difficulty?: FibPoints;
  /** Free-text notes shown in the detail modal. */
  description?: string;
  /** Comment count, shown as "💬 N" on the row. */
  commentCount?: number;
  /** ISO timestamp of last update — drives the "Updated" column. */
  updatedAt?: string;
  /** ISO timestamp the task was completed (set on done, cleared on reopen). */
  completedAt?: string;
  /** Nested sub-tasks, revealed when the row is expanded. */
  subtasks?: Task[];
  /** Image attachments (pasted or uploaded). */
  attachments?: Attachment[];
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
    | "reopened"
    | "comment" // human- or AI-authored note
    | "attached" // an image was attached or removed
    | "updated"; // one or more fields changed via a bulk update
  message: string;
  /** Who wrote/triggered it — e.g. "You", "Claude", an assignee name. */
  author?: string;
}
