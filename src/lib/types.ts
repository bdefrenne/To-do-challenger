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
}

/**
 * A task's workflow phase, DERIVED from its lifecycle timestamps + lock state
 * (never stored). Kanban `status` is orthogonal to this.
 */
export type TaskPhase =
  | "draft" // code still soft (unlocked)
  | "ready" // locked, analysis not started
  | "analyzing" // analysisStartedAt set, analyzedAt not
  | "analyzed" // analyzedAt set, workStartedAt not
  | "working" // workStartedAt set, not done
  | "done"; // completedAt set

/** A decision's category — drives the Decisions-page filter. */
export type DecisionCategory =
  | "business"
  | "product"
  | "ux"
  | "technical"
  | "scope";

/** Which lifecycle phase a decision was made in. */
export type DecisionPhase = "analysis" | "execution";

/** Retro verdict on a decision (null until reviewed). */
export type DecisionOutcome = "good" | "mixed" | "bad";

/** A recorded decision — first-class, cross-task, retro-reviewable. */
export interface Decision {
  id: string;
  taskId: string;
  category: DecisionCategory;
  decision: string;
  rationale?: string | null;
  phase: DecisionPhase;
  author?: string | null;
  createdAt: string; // ISO
  outcome?: DecisionOutcome | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  supersededById?: string | null;
}

/** A note's type — lets the standup digest group them. */
export type NoteType = "progress" | "blocker" | "question" | "fyi";

/** A team-facing note surfaced at standup. */
export interface Note {
  id: string;
  taskId: string;
  type?: NoteType | null;
  note: string;
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
  /** Lifecycle timestamps (ISO) — informational, non-gating. */
  analysisStartedAt?: string | null;
  analyzedAt?: string | null;
  workStartedAt?: string | null;
  /** Revisable summaries written across the workflow. */
  analysisSummary?: string | null;
  plan?: string | null;
  summary?: string | null;
  /** Which board the task lives on (null/undefined = unassigned). */
  boardId?: string | null;
  /** Which project the task is scoped to (for board-less tasks). */
  projectId?: string | null;
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
