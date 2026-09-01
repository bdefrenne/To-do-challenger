/*
  Types for To-do Challenger — a lightweight, ClickUp-style task manager.
  These keep the mock data honest and self-documenting. They're a starting
  shape, not a schema lock — swap the mock store for a real API later.
*/

/**
 * The task's single process axis — status *is* the workflow. The List/Kanban
 * views group by these; the two handoffs are To Do → Analyzing (understand +
 * plan) and Analyzed → Building (execute). See docs/task-flow.md.
 */
export type TaskStatus =
  | "backlog"
  | "todo"
  | "analyzing"
  | "analyzed"
  | "building"
  | "review"
  | "done";

/**
 * Where a task sits on the canvas — its triage bucket, an axis entirely
 * independent of `status`. Writers name one of these and the service resolves it
 * to a `canvasSectionId` pin (see `resolvePlacementSection`); nothing stores the
 * word itself.
 *
 *   inbox         untriaged — no pin, so it surfaces in its board's INBOX lane
 *   thisWeek      scheduled for this week — the starred group's lane for its board
 *   backlog       triaged, not scheduled
 *   later         deliberately deferred
 *   doneThisWeek  finished this week, not yet swept
 *
 * Note `backlog` here is the *place*, unrelated to the `backlog` TaskStatus: a
 * task can be Building and still parked in the LATER group, and moving a card
 * between groups never touches its status.
 */
export type TaskPlacement =
  | "inbox"
  | "thisWeek"
  | "backlog"
  | "later"
  | "doneThisWeek";

/** How often a task repeats. */
export type Recurrence = "none" | "daily" | "weekly" | "monthly";

/**
 * Fibonacci points, story-point style. Used for both `value` (payoff) and
 * `difficulty` (effort) — multiply them for a rough "challenge score".
 */
export type FibPoints = 1 | 2 | 3 | 5 | 8;

/**
 * Importance ladder (priority): `2` High · `1` Elevated · `0` Normal (default) ·
 * `-1` Low. Higher = more urgent; negatives deprioritize. See
 * src/lib/importance.ts for labels/tones.
 */
export type Importance = -1 | 0 | 1 | 2;

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
  /** Put away, not deleted (TD2-213): the board is drawn nowhere but the
   *  project's settings modal. Only ever `true` on a board that arrived in
   *  {@link Project.hiddenBoards} — the split is what does the hiding, this
   *  flag is what lets settings label and toggle it. */
  hidden?: boolean;
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
  /** The boards this project SHOWS, in `position` order. Hidden ones are not
   *  here — see `hiddenBoards`. That split is deliberate: every surface that
   *  renders a project's boards reads this field, so hiding is the default and a
   *  new surface inherits it rather than having to remember a filter. */
  boards?: Board[];
  /** The boards that are put away (TD2-213), same order. Read by the project's
   *  settings modal (the only place they're shown, and where they're brought
   *  back) and, unioned with `boards` via `allBoards`, by anything asking what a
   *  board is CALLED — a task on a hidden board still shows up in the Trash, the
   *  Archived view and the task table, and must name its board there. */
  hiddenBoards?: Board[];
  /** Roster user ids who are members of this project — the assignee picker on
   *  the project's tasks offers only these people (empty ⇒ whole-roster
   *  fallback). Boards inherit their project's members. The owner is always
   *  included. */
  members?: string[];
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
  /** True once the code is locked (frozen) — locks when status enters
   *  Analyzing (the first handoff). */
  refLocked?: boolean;
  /** Revisable free-text fields written across the workflow (no length limit):
   *  Analysis (what & why), Technical Plan (how), Summary (what shipped). */
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
  /** The canvas Section this task is pinned to (a `CanvasNode.id`), or null for
   *  "not placed" — the normal state. A canvas resolves an unpinned task into
   *  its board's INBOX lane, so tasks created from the API, MCP or a board view
   *  show up without anyone tagging them; pinning is an explicit override
   *  written when someone drags a card into a section. An id belonging to a
   *  DIFFERENT canvas (or to a deleted node) reads as unpinned — see
   *  `resolveSectionId`. */
  canvasSectionId?: string | null;
  /** Payoff points (Fibonacci) — the "value" axis. */
  value?: FibPoints;
  /** Effort points (Fibonacci) — the "difficulty" axis. */
  difficulty?: FibPoints;
  /** Importance/priority (−2…3, default 0 Normal). See Importance. */
  importance?: Importance;
  /** Free-text notes shown in the detail modal. Nullable like the column it
   *  mirrors (and like Project/Board above): `null` is how a caller CLEARS it,
   *  which is distinct from omitting the key to leave it alone. */
  description?: string | null;
  /** Comment count, shown next to a speech-bubble icon on the row. */
  commentCount?: number;
  /** ISO timestamp of last update — drives the "Updated" column. */
  updatedAt?: string;
  /** ISO timestamp the task was completed (set on done, cleared on reopen). */
  completedAt?: string;
  /** ISO timestamp a done task was archived (hidden from active views); null
   *  when not archived. Cleared on un-archive or when the task leaves "done". */
  archivedAt?: string | null;
  /** ISO timestamp the task was DELETED — it's in the Trash, off every active
   *  view, restorable one press at a time until the bin is emptied. Null when
   *  the task is live. Sorting the Trash on this is what makes it a bin: newest
   *  deleted first. */
  deletedAt?: string | null;
  /** Nested sub-tasks, revealed when the row is expanded. */
  subtasks?: Task[];
  /** Image attachments (pasted or uploaded). */
  attachments?: Attachment[];
}

/* ---- Canvas / whiteboard ---- */

/** What a canvas node is: a markdown text block, a section (a Figma-style titled
 *  board container whose lines are that board's live tasks), a `draw` freehand
 *  pen stroke (its sampled points ride in `data`), an `image` (a pasted or
 *  dropped picture whose blob URL rides in `data.url`), or a `section_group` (a
 *  movable container that arranges its member sections — each tagged with
 *  `data.groupId` — under a big title, in a column or a row per its
 *  `data.layout`: "portrait" (default) or "landscape"). The `canvas_node_kind` DB
 *  enum still carries a legacy `frame` value (the feature was removed); nothing
 *  writes it, so it never reaches this type. */
export type CanvasNodeKind = "text" | "section" | "draw" | "image" | "section_group";

/** Last-saved pan/zoom of a canvas. Canvas coordinates, not screen pixels. */
export interface CanvasViewport {
  x: number;
  y: number;
  scale: number;
}

/** A project's whiteboard. Exactly one per project — that 1:1 is what lets the
 *  server resolve "which canvas does this task's placement go on?" as a lookup
 *  rather than a guess (TD-136). `nodes` is attached when fetching one. */
export interface Canvas {
  id: string;
  projectId: string;
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
  /** Free-form extras (e.g. a section's bound `boardId` and optional own
   *  `name`; a group's `layout`). */
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
  /** Who wrote/triggered it — e.g. "You", "Claude", an assignee name. Legacy
   *  display label; `actorId` is the real acting user. */
  author?: string;
  /** The real acting user's account id (absent on legacy rows). */
  actorId?: string;
  /** Which surface produced the event: web UI, API/script, Claude (MCP), or the
   *  Telegram bot. */
  source?: "ui" | "api" | "mcp" | "telegram";
}
