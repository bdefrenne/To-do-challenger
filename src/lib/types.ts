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

/** One Trello-style board — the sub level of the hierarchy. */
export interface Board {
  id: string;
  projectId: string;
  name: string;
  /** ≤4-char ref prefix (e.g. "GH") — the primary source of a task's code.
   *  Doubles as the board's shortname in the tasks list. */
  code?: string | null;
  /** Accent color (hex). Always present (column default). */
  color?: string;
  /** Board picture — a public blob URL, or null for none. */
  image?: string | null;
  /** Path to this board's git working directory. */
  gitFolder?: string | null;
  /** Markdown readme: what this board is and its constraints. */
  description?: string | null;
}

/** Top level of the hierarchy (e.g. a whole game); holds Boards. */
export interface Project {
  id: string;
  name: string;
  /** ≤4-char ref prefix used when a task is project-scoped but board-less.
   *  Doubles as the project's shortname. */
  code?: string | null;
  /** Accent color (hex). Always present (column default). */
  color?: string;
  /** Project picture — a public blob URL, or null for none. */
  image?: string | null;
  /** Path to this project's git working directory. */
  gitFolder?: string | null;
  /** Markdown readme: what this project is and its constraints. */
  description?: string | null;
  boards?: Board[];
  /** Roster user ids who are members of this project — the assignee picker on
   *  the project's tasks offers only these people (empty ⇒ whole-roster
   *  fallback). Boards inherit their project's members. The owner is always
   *  included. */
  members?: string[];
}

/**
 * A task's workflow phase, DERIVED from its lifecycle state (never stored).
 * Progress ("am I working on it") lives in the kanban `status`; phase only
 * tracks the analysis lifecycle.
 */
export type TaskPhase =
  | "draft" // code still soft (unlocked)
  | "ready" // locked, not yet analyzed
  | "analyzed" // analyzedAt set
  | "done"; // completedAt set

/** A note's type. `decision` = a choice made (optional "Why" in the body);
 *  the rest are standup-worthy callouts. */
export type NoteType =
  | "decision"
  | "progress"
  | "milestone"
  | "blocker"
  | "question"
  | "fyi";

/** A note on a task — a decision or a standup-worthy callout. */
export interface Note {
  id: string;
  taskId: string;
  type?: NoteType | null;
  note: string;
  tags: string[];
  author?: string | null;
  createdAt: string; // ISO
}

/** A git commit linked back to a task. */
export interface TaskCommit {
  id: string;
  taskId: string;
  sha: string;
  subject?: string | null;
  createdAt: string; // ISO
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
  /** Human-friendly code (e.g. "GH-20", or "GH-20*" while unlocked/soft). */
  code?: string;
  /** The frozen code string once locked (null while soft). */
  ref?: string | null;
  /** True once the code is locked (frozen) — handoff or first mutation. */
  refLocked?: boolean;
  /** Derived workflow phase (see TaskPhase) — not the kanban status. */
  phase?: TaskPhase;
  /** When analysis was marked done (ISO) — optional, informational. */
  analyzedAt?: string | null;
  /** Revisable summaries written across the workflow. */
  analysisSummary?: string | null;
  plan?: string | null;
  summary?: string | null;
  /** Which board the task lives on (null/undefined = unassigned). */
  boardId?: string | null;
  /** Which project the task is scoped to (for board-less tasks). */
  projectId?: string | null;
  /** Account ids of the people assigned (empty/undefined = unassigned).
   *  Resolve to a person via PeopleContext (`resolveById`). Writes accept a
   *  name/email/id and are resolved to ids server-side. */
  assigneeIds?: string[];
  /** ISO date work should start — pairs with dueDate (the end). */
  startDate?: string;
  /** ISO date the task is due — drives the Due column (overdue shows red). */
  dueDate?: string;
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

/* ---- Canvas / whiteboard ---- */

/** What a canvas node is: a markdown text block, or a section (a Figma-style
 *  titled board container whose lines are that board's live tasks). The
 *  `canvas_node_kind` DB enum still carries a legacy `frame` value (the feature
 *  was removed); nothing writes it, so it never reaches this type. */
export type CanvasNodeKind = "text" | "section";

/** Last-saved pan/zoom of a canvas. Canvas coordinates, not screen pixels. */
export interface CanvasViewport {
  x: number;
  y: number;
  scale: number;
}

/** A standalone whiteboard document. `nodes` is attached when fetching one. */
export interface Canvas {
  id: string;
  name: string;
  viewport?: Partial<CanvasViewport>;
  createdAt?: string; // ISO
  updatedAt?: string; // ISO
  nodes?: CanvasNode[];
}

/** One element on a canvas — a text block or a section (board). Position/size
 *  are in canvas coordinates so they're stable under pan/zoom. */
export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  /** Markdown for a text node; the label/title for a section. */
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional accent (hex). */
  color?: string | null;
  /** Fractional z-order (higher = on top). */
  position: number;
  /** Free-form extras (e.g. a section's bound `boardId`). */
  data?: Record<string, unknown>;
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
