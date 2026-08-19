"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type {
  Task,
  TaskStatus,
  TaskPlacement,
  TaskLogEntry,
  Project,
  Board,
  Note,
  NoteType,
  TaskCommit,
} from "@/lib/types";
import {
  deletionOf,
  placementOfTask,
  trayOfPlacement,
  type PlacementMap,
  type SystemGroup,
} from "@/lib/sections";
import { compareTaskOrder, insertRelative } from "@/lib/task-order";
import { MAX_BULK_OPS, type OpResult } from "@/lib/bulk";

/*
  ====================================================================
  WORKSPACE STORE — now backed by the API (was in-memory).
  Same public interface as before, so no screen changes. Internally it:
    • loads tasks from /api/tasks (the shared source of truth)
    • applies optimistic updates for instant feel
    • POSTs the intent to the API, then reconciles
    • polls every few seconds + on window focus, so edits made by
      Claude / any AI show up on your board live.
  ====================================================================
*/

/** Position of a drop relative to the target row. */
export type DropPos = "before" | "after" | "inside";

/**
 * Where exactly a filed card should land: next to `targetId`, within the run the
 * user can SEE (`orderedIds`, in `compareTaskOrder` order, over exactly the
 * cards rendered in the destination column).
 *
 * The run has to be the rendered one — position is minted per (status, parent)
 * and never renumbered, so any list that mixes statuses (a canvas Section, a
 * Boards-view column) routinely holds ties. `insertRelative` + a dense restamp
 * is the only way to make a drop index a real position; interpolating a gap is
 * degenerate whenever the neighbours tie.
 */
export type PlaceAt = {
  targetId: string;
  pos: "before" | "after";
  orderedIds: readonly string[];
};

/** Which handoff prompt to copy — see `src/lib/prompts.ts`. */

/** Ordered tree node: parentId = nesting, position = order within group. */
/**
 * How the mounted canvas answers placement questions for the shared drag paths.
 * Section membership is derived per canvas, so it can't be read off a task —
 * the canvas owns the resolution and lends it here.
 */
export interface PlacementResolver {
  /** The Section node a card renders in — an INBOX lane counts — or null when
   *  this canvas can't show it. */
  sectionOf: (taskId: string) => string | null;
  /** What to WRITE to place a task in that Section: the node id, or null for an
   *  INBOX lane, since belonging to a lane IS the absence of a pin. */
  pinFor: (sectionNodeId: string | null) => string | null;
  /** Ids of the tasks currently rendering in that Section, for position math. */
  membersOf: (sectionNodeId: string | null) => Set<string>;
  /** Which machine-managed tray a card is sitting in, if any — what makes
   *  DELETE mean "archive" for a card already parked in DONE THIS WEEK. */
  groupOf: (taskId: string) => SystemGroup | null;
  /**
   * The Section a board's cards go to for a given placement — the lane inside
   * THIS WEEK / BACKLOG / LATER / DONE THIS WEEK, or null for `"inbox"` (which
   * IS the absence of a pin) and for a placement this canvas has no group for.
   *
   * MATERIALISES the lane if it doesn't exist yet, so the answer is a node the
   * caller can pin to immediately. The server can afford to name a lane that
   * doesn't exist and let the reconciler catch up a tick later; a card the user
   * just flung would visibly bounce through INBOX in the meantime.
   */
  laneFor: (placement: TaskPlacement, boardId: string | null) => string | null;
}

export interface TaskNode {
  id: string;
  parentId: string | null;
  boardId: string | null;
  status: TaskStatus;
  statusSince: string; // ISO — when it entered the current status
  position: number;
  /** Creation time — the tiebreak that makes `position` a total order. Carried
   *  on the node so any list can be sorted with `compareTaskOrder` without
   *  reaching into `taskMap`. */
  createdAt: string; // ISO
}

interface WorkspaceContextValue {
  nodes: TaskNode[];
  taskMap: Record<string, Task>;
  logs: Record<string, TaskLogEntry[]>;
  /** Per-task workflow detail, loaded alongside the activity log. */
  notes: Record<string, Note[]>;
  /** Stickies for whichever canvas is currently mounted (keyed by canvasId).
   *  Only ever populated for `registerOpenCanvas`'s current id. */
  canvasNotes: Record<string, Note[]>;
  /** Canvas-only: tell this context which canvas (if any) is on screen, so
   *  the poll/remote-refresh loop knows to keep its stickies current. Pass
   *  null on unmount. Mirrors `registerPlacement` below. */
  registerOpenCanvas: (canvasId: string | null) => void;
  /** Drop a sticky at a canvas position. `taskHandle` optionally ALSO links
   *  it to a task — the two anchors aren't exclusive. */
  addCanvasNote: (
    canvasId: string,
    x: number,
    y: number,
    input: { note: string; type?: NoteType; tags?: string[] },
    taskHandle?: string,
  ) => Promise<void>;
  /** Persist a sticky's dropped position (called once on pointerup). */
  moveCanvasNote: (canvasId: string, noteId: string, x: number, y: number) => Promise<void>;
  /** Check off (resolve) or re-open a sticky. */
  resolveCanvasNote: (canvasId: string, noteId: string, resolved: boolean) => Promise<void>;
  /** Permanently remove a sticky (its "×"). No undo. */
  deleteCanvasNote: (canvasId: string, noteId: string) => Promise<void>;
  commits: Record<string, TaskCommit[]>;
  projects: Project[];
  /** Stack of open task-detail modals (bottom → top). Each click pushes a new
   *  level; the whole stack is mirrored to the URL so a refresh restores it. */
  openTaskIds: string[];
  openTask: (id: string) => void;
  /** Close the topmost modal (pops one level). */
  closeTask: () => void;
  /** Close every open modal (clears the stack). */
  closeAllTasks: () => void;
  /** Create a subtask under `parentId` and open its modal stacked on top. */
  addSubtask: (parentId: string, title: string) => Promise<void>;
  childrenOf: (id: string | null) => TaskNode[];
  nodeById: (id: string) => TaskNode | undefined;
  /** The same two answers as indexes, for callers that ask about MANY tasks.
   *
   *  `childrenOf`/`nodeById` scan the whole tree per call, which is fine for a
   *  modal asking about one task and quadratic for a view walking hundreds. The
   *  canvas is that view: every Section resolves its own subtree, so a per-call
   *  scan made the cost O(sections × tasks) and every task change re-paid it
   *  (TD-132). Both are rebuilt only when `nodes` changes, and `childIndex`'s
   *  arrays are pre-sorted in `compareTaskOrder`, so a lookup is just a lookup.
   *
   *  Treat the arrays as READ-ONLY — they're shared by every caller. */
  childIndex: Map<string | null, TaskNode[]>;
  nodeIndex: Map<string, TaskNode>;
  /** Canvas-only: lend this context your Section resolution so the shared drag
   *  paths can re-pin correctly. Pass null on unmount. */
  registerPlacement: (resolver: PlacementResolver | null) => void;
  /** Hand over a fetched `sectionId → placement` map (/api/placements) so the
   *  workspace can name a card's bucket exactly, even one pinned to a hand-made
   *  section inside a system group. Without it the pin id still answers for every
   *  machine-made lane — see `placementOf`. */
  registerPlacementMap: (map: PlacementMap) => void;
  start: (id: string) => void;
  toggleDone: (id: string) => void;
  setStatus: (id: string, status: TaskStatus) => void;
  /** Edit content fields (title/description/…); guarded against concurrent
   *  writes via `X-Expected-Updated-At` — a conflict surfaces `notice` and
   *  reloads. Persists immediately; use for discrete edits (assignees, dates,
   *  one-shot title). */
  editTask: (id: string, patch: TaskEdit) => void;
  /** Live edit for high-frequency text (description/title while typing): instant
   *  to peers, Postgres write batched ~10s (or flushed via `flushEdits`). */
  editTaskLive: (
    id: string,
    patch: TaskEdit,
    opts?: { optimistic?: boolean; broadcast?: boolean },
  ) => void;
  /** Force-write any pending batched edits now (call on blur / before close). */
  flushEdits: () => Promise<void>;
  /** Toggle the current user in/out of a task's assignees — the canvas SPACE
   *  hover shortcut. No-op when the viewer isn't a known user. */
  toggleSelfAssignee: (id: string) => void;
  /** Delete a task with a ~5s undo window — the DELETE hover shortcut. What it
   *  actually does follows `deletionOf` (delete · park · archive); pass
   *  `opts.tray` off canvas when the view knows which bucket the card renders in,
   *  so parking and the archiving second press work there too.
   *  See `undoDelete` (cancel) and `pendingDeletes` (the toast). */
  deleteTask: (id: string) => void;
  /** Cancel pending deletes and restore the tasks; no id ⇒ ALL still inside their
   *  window, since one run of DELETE presses is one action to undo.
   *  Returns whether anything was undone (canvas Ctrl+Z tries this first). */
  undoDelete: (id?: string) => boolean;
  /** Tasks inside their delete undo window (oldest → newest), for the toast.
   *  `mode` distinguishes a real delete from a done-task archive. */
  pendingDeletes: { id: string; title: string; mode: "delete" | "archive" }[];
  /** Archive every done task in scope (a board, a project, or all when omitted).
   *  Returns how many were archived. */
  archiveAllDone: (scope?: { boardId?: string; projectId?: string }) => Promise<number>;
  moveNode: (dragId: string, targetId: string, pos: DropPos) => void;
  /** Re-pin a dragged card (and re-home its subtree's board). `targetPin` is what
   *  to write: a Section node id, or **null** to unpin — which is how a card
   *  belongs to an INBOX lane. */
  /** Send a card to a group: THIS WEEK (end of the list), BACKLOG or LATER (top),
   *  DONE THIS WEEK, or INBOX (unpinned). The hover arrows' path — on canvas it
   *  moves the node, off canvas it files via `fileTask`. */
  sendToPlacement: (id: string, to: TaskPlacement) => void;
  /** The latest arrow-key send, for its undo toast (overwritten each time, not
   *  a queue — see `pendingSend`'s declaration for why). */
  pendingSend: { id: string; title: string; to: TaskPlacement; fromPin: string | null } | null;
  /** Put the pending send back where it came from. */
  undoSend: () => void;
  /** Dismiss the send-undo toast without reversing it (its auto-dismiss). */
  clearPendingSend: () => void;
  moveNodeIntoSection: (
    dragId: string,
    targetPin: string | null,
    targetBoardId: string | null,
    opts?: {
      targetId?: string;
      pos?: DropPos;
      siblingIds?: Set<string>;
      status?: TaskStatus;
    },
  ) => void;
  dropToGroup: (dragId: string, status: TaskStatus) => void;
  /** Move a task onto a board (optionally also set its status). */
  moveToBoard: (id: string, boardId: string, status?: TaskStatus) => void;
  /** File a task on a board AND in a placement bucket in one write — the
   *  project Boards view's drop. Unlike `sendToPlacement` this needs no mounted
   *  canvas: the server resolves the bucket to a pin (`resolvePlacementSection`).
   *  Resolves once the write has landed and the refetch has run. */
  fileTask: (
    id: string,
    boardId: string,
    placement: TaskPlacement,
    opts?: { status?: TaskStatus; at?: PlaceAt },
  ) => Promise<void>;
  /** `fileTask` for a whole set of cards on ONE board — a column sweep, in one
   *  bulk batch rather than one request per card. Status is left alone. */
  fileTasks: (ids: string[], placement: TaskPlacement) => Promise<void>;
  /** Buckets requested by a `fileTask` still in flight (taskId → placement) —
   *  read these over the resolved pins so a filed card shows where it's going. */
  pendingPlacements: Record<string, TaskPlacement>;
  addTask: (
    status: TaskStatus,
    title: string,
    boardId?: string | null,
    placement?: TaskPlacement,
  ) => void;
  /** Create a task inside a canvas Section, optionally nested under `parentId`.
   *  Optimistic, like `addTask`. */
  addSectionTask: (input: {
    title: string;
    /** Pin the new card to this Section, or null to leave it unpinned — which is
     *  what an INBOX lane and a subtask both want. */
    canvasSectionId: string | null;
    boardId: string | null;
    parentId?: string | null;
    siblingIds?: Set<string>;
    /** Land the new card immediately ABOVE this sibling instead of at the end —
     *  what a composer opened in the gap between two cards passes. */
    insertBefore?: string | null;
  }) => void;
  /** Post a comment to a task's thread (attributed to "You"). */
  addComment: (id: string, message: string) => Promise<void>;
  /** Lock the task's code (freeze it) and return a ready-to-paste work prompt. */
  lockTask: (id: string) => Promise<string>;
  /** Return a ready-to-paste handoff prompt by kind. Every kind locks the code
   *  first (the analyze handoff is the first commitment). */
  /** Add a note to a task (decision or standup callout), then reload its detail. */
  addNote: (
    id: string,
    input: { note: string; type?: NoteType; tags?: string[] },
  ) => Promise<void>;
  /** Check off (resolve) or re-open a note on a task. */
  resolveNote: (taskId: string, noteId: string, resolved: boolean) => Promise<void>;
  /** Edit workflow summary fields (analysisSummary / plan / summary). */
  editWorkflow: (
    id: string,
    patch: Partial<Pick<Task, "analysisSummary" | "plan" | "summary">>,
  ) => Promise<void>;
  /** Upload an image onto a task (from a file picker or clipboard paste). */
  addAttachment: (id: string, file: File) => Promise<void>;
  /** Remove an image attachment from a task. */
  removeAttachment: (taskId: string, attachmentId: string) => Promise<void>;
  /** Create a project; returns the created project (or null on failure) so the
   *  caller can upload a picture onto its fresh id. */
  createProject: (input: {
    name: string;
    code?: string;
    color?: string;
    gitFolder?: string;
    description?: string;
    /** Roster user ids to seed as members (owner auto-included). */
    members?: string[];
  }) => Promise<Project | null>;
  /** Edit a project's name / shortname / color / picture / git folder / readme /
   *  members. `image`/`gitFolder`/`description` accept null to clear; `members`
   *  replaces the whole set (owner always kept). */
  renameProject: (
    id: string,
    patch: {
      name?: string;
      code?: string;
      color?: string;
      image?: string | null;
      gitFolder?: string | null;
      description?: string | null;
      members?: string[];
    },
  ) => Promise<void>;
  /** Upload a project picture (client crops to a square first). */
  uploadProjectAvatar: (projectId: string, blob: Blob) => Promise<void>;
  deleteProject: (id: string) => void;
  /** Create a board; returns the created board (or null on failure) so the
   *  caller can, e.g., upload a picture onto its fresh id. */
  createBoard: (
    projectId: string,
    input: {
      name: string;
      code?: string;
      color?: string;
      gitFolder?: string;
      description?: string;
    },
  ) => Promise<Board | null>;
  /** Edit a board's name / shortname (code) / color / picture / git folder /
   *  readme. `image`/`gitFolder`/`description` accept null to clear. */
  renameBoard: (
    id: string,
    patch: {
      name?: string;
      code?: string;
      color?: string;
      image?: string | null;
      gitFolder?: string | null;
      description?: string | null;
    },
  ) => Promise<void>;
  /** Upload a board picture (client crops to a square first). */
  uploadBoardAvatar: (boardId: string, blob: Blob) => Promise<void>;
  deleteBoard: (id: string) => void;
  /** Reorder the boards within a project (drives Boards view + sidebar). */
  reorderBoards: (projectId: string, orderedIds: string[]) => void;
  /** Force-reload tasks + projects now (e.g. after a canvas Section commits a
   *  batch of tasks directly via /api/tasks/bulk, bypassing the mutate layer). */
  refresh: () => Promise<void>;
  /** Send a batch to /api/tasks/bulk. Chunks past the server's cap, reports any
   *  op that failed, and returns results index-aligned with the ops you passed.
   *  Use this rather than fetching the endpoint directly. */
  bulk: (operations: unknown[]) => Promise<OpResult[]>;
  /** Subscribe to LOCAL task-data mutations (the canvas Liveblocks bridge uses
   *  this to broadcast a "tasks-changed" ping to peers). Returns an unsubscribe. */
  subscribeLocalChange: (cb: (s: ChangeSignal) => void) => () => void;
  /** Apply a peer's field delta directly to local state (used by the canvas
   *  Liveblocks bridge on an incoming `task-patch` room event). */
  applyRemotePatch: (id: string, patch: TaskEdit) => void;
  /** Reload task data in response to a PEER's broadcast (debounced; never
   *  re-emits, so broadcasts don't ping-pong between clients). */
  refreshFromRemote: () => void;
  /** Transient user-facing message (e.g. a concurrent-edit conflict). */
  notice: string | null;
  clearNotice: () => void;
  /** A completion the subtask rule refused, awaiting an answer: finish the whole
   *  branch, or leave it. Null when there's nothing pending. Unlike `notice` this
   *  does NOT auto-dismiss — it's a question, and the answer writes data. */
  pendingComplete: {
    taskId: string;
    taskTitle: string;
    openCount: number;
  } | null;
  /** Complete a task AND every unfinished task under it (the pending prompt's
   *  "Complete all" answer). Deliberately the only way to cascade a completion —
   *  nothing does it implicitly. */
  completeBranch: (id: string) => void;
  /** Dismiss the prompt without completing anything. */
  clearPendingComplete: () => void;
  /** Id of the project whose settings modal is open (from anywhere — e.g. the
   *  assignee picker's "Edit Project Members"), or null. */
  projectSettingsId: string | null;
  openProjectSettings: (id: string) => void;
  closeProjectSettings: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/* How often the change-cursor is polled. Adaptive: POLL_MIN_MS while the board
   is actually moving, doubling to POLL_MAX_MS once it goes quiet, and snapping
   back on focus/visibility or the next real change. A fixed 2 s poll meant a
   tab left open all day cost a DB round-trip every 2 s forever, which is most
   of what put Neon's egress at 80% of its allowance (PLAT-403). */
const POLL_MIN_MS = 2000;
const POLL_MAX_MS = 30000;
// How long batched text edits sit before being written to Postgres. The canvas
// stays LIVE meanwhile via delta broadcasts; peers apply them without a DB read.
const EDIT_FLUSH_MS = 10000;
// Backstop so a live edit whose author disconnected before flushing doesn't
// linger in the overlay forever (must exceed EDIT_FLUSH_MS).
const OVERLAY_TTL_MS = 30000;
// Grace period between a canvas DELETE and the real Postgres delete — the window
// in which the "Deleted · Undo" toast (or Ctrl+Z) can bring the task back.
const UNDO_WINDOW_MS = 5000;
/* The three fields a LIST read deliberately leaves in Postgres (PLAT-403,
   `LIST_TASK_COLUMNS`) — they're ~2/3 of a board payload and render on one
   surface. Only the detail read (`loadLogs` → GET /api/tasks/:id) carries them,
   and it marks "not fetched" as ABSENT (vs `null` for "has none"). So a
   list-driven map replace has to graft the fetched values forward, or an open
   modal's Analysis / Technical Plan / Summary blank out on the next poll. */
const WORKING_FIELDS = ["analysisSummary", "plan", "summary"] as const;

/** A partial task edit the client can PATCH. */
export type TaskEdit = Partial<
  Pick<
    Task,
    | "title"
    | "status"
    | "assigneeIds"
    | "startDate"
    | "dueDate"
    | "recurrence"
    | "dependsOn"
    | "customFields"
    | "value"
    | "difficulty"
    | "importance"
    | "description"
  >
>;

/** What a local change broadcasts to peers. `refetch` = structural change, peers
 *  reload from Postgres; `patch` = a batched field delta peers apply directly to
 *  their taskMap (so the view is live even though the DB write is deferred);
 *  `notesRefetch` = a canvas sticky changed (add/move/resolve) — peers reload
 *  just that canvas's notes, not the whole task/project state. */
export type ChangeSignal =
  | { kind: "refetch" }
  | { kind: "patch"; taskId: string; patch: TaskEdit }
  | { kind: "notesRefetch"; canvasId: string };

/** Human-authored content fields. An edit touching any of these opts into the
 *  optimistic-concurrency check; positional/status-only writes don't
 *  (they're last-write-wins and self-heal on the next refetch). */
const CONTENT_FIELDS: (keyof TaskEdit)[] = [
  "title",
  "description",
  "assigneeIds",
  "startDate",
  "dueDate",
  "recurrence",
  "dependsOn",
  "customFields",
  "value",
  "difficulty",
];

/* ---- Types coming back from the API (superset of Task). ---- */
interface TaskDTO extends Task {
  parentId: string | null;
  boardId: string | null;
  position: number;
  statusSince: string;
  createdAt: string;
}

/** Fetch error that preserves the status code + parsed body so callers can
 *  react to specific cases (e.g. a 409 conflict carrying the fresh task). */
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

/* ---- Small fetch helper (same-origin: no token needed). ---- */
async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // Session expired / signed out in another tab — back to login.
    if (res.status === 401 && typeof window !== "undefined") {
      window.location.href = "/login";
    }
    const raw = await res.text().catch(() => "");
    let body: unknown = raw || null;
    try {
      if (raw) body = JSON.parse(raw);
    } catch {
      /* not JSON — keep the raw text */
    }
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : raw || res.statusText;
    throw new ApiError(res.status, `${res.status}: ${detail}`, body);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

/**
 * The server's own sentence for a rejected write, or null if it didn't send one.
 *
 * Read off `body.error` rather than `ApiError.message`, which is prefixed with
 * the status code for the console's benefit — "400: …" in a toast reads as a
 * crash rather than as the rule it is. Only worth showing for a `ValidationError`
 * (400), where the message is written for a person; other statuses carry
 * framework text.
 */
/** A refused completion, as the server describes it — see `openSubtasksError`
 *  (db/service.ts) and `RuleDetails` (api.ts). */
interface OpenSubtasksRule {
  code: "open_subtasks";
  taskId: string;
  taskTitle: string;
  openCount: number;
}

/**
 * Is this the "finish the subtasks first" refusal? If so, hand back its payload
 * so the caller can offer the branch completion instead of only reporting a wall.
 *
 * Guarded field by field rather than cast: the body is JSON off the wire, and a
 * toast with an undefined count in it is worse than the generic message.
 */
function openSubtasksRule(e: ApiError): OpenSubtasksRule | null {
  const b = e.body;
  if (!b || typeof b !== "object") return null;
  const d = b as Record<string, unknown>;
  if (d.code !== "open_subtasks") return null;
  if (typeof d.taskId !== "string" || typeof d.openCount !== "number") return null;
  return {
    code: "open_subtasks",
    taskId: d.taskId,
    taskTitle: typeof d.taskTitle === "string" ? d.taskTitle : "this task",
    openCount: d.openCount,
  };
}

function ruleMessage(e: ApiError): string | null {
  const detail =
    e.body && typeof e.body === "object" && "error" in e.body
      ? String((e.body as { error: unknown }).error)
      : "";
  return detail.trim() || null;
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

export function WorkspaceProvider({
  children,
  /** Display name of the signed-in user — used as the authorship label. */
  meName = "You",
  /** Account id of the signed-in user — new tasks are auto-assigned to them. */
  meId,
}: {
  children: ReactNode;
  meName?: string;
  meId?: string;
}) {
  const [nodes, setNodes] = useState<TaskNode[]>([]);
  const [taskMap, setTaskMap] = useState<Record<string, Task>>({});
  const [logs, setLogs] = useState<Record<string, TaskLogEntry[]>>({});
  const [notes, setNotes] = useState<Record<string, Note[]>>({});
  const [commits, setCommits] = useState<Record<string, TaskCommit[]>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  // Stack of open task-detail modals (bottom → top). Empty = nothing open.
  const [openTaskIds, setOpenTaskIds] = useState<string[]>([]);
  // Transient, user-facing message (e.g. a write was rejected as a conflict).
  const [notice, setNotice] = useState<string | null>(null);
  // A completion the subtask rule refused, waiting on an answer (see
  // `openSubtasksRule` and the CompleteBranchPrompt toast in AppShell).
  const [pendingComplete, setPendingComplete] =
    useState<OpenSubtasksRule | null>(null);
  // Project whose settings modal is open globally (opened from the assignee
  // picker's "Edit Project Members", the sidebar gear, etc.). AppShell renders
  // the single ProjectModal driven by this.
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null);

  // Pause polling while a local mutation is in flight, so a background
  // refetch can't clobber an optimistic update mid-op.
  const inflight = useRef(0);

  // Monotonic counter bumped when any mutation STARTS. `fetchAll` snapshots it
  // before its request and discards the result if it changed meanwhile — a
  // mutation raced the fetch, so the fetched snapshot may predate that write.
  // Makes reconciliation timing-independent (an in-flight fetch can never clobber
  // newer optimistic state); `inflight` alone can't catch an op that starts AND
  // finishes during one fetch.
  const reconcileSeq = useRef(0);

  // Last change-cursor we've reconciled to. The poll compares the server's
  // cursor against this and only re-fetches when it moves.
  const lastVersion = useRef<string | null>(null);

  // Server-stamped instant of our last successful task read — the watermark a
  // delta read asks from ("only what changed since"). Null until the first full
  // fetch lands, which is why `fetchDelta` falls back to a full read.
  const lastSyncAt = useRef<string | null>(null);

  // The last map we applied, at full DTO width, readable from callbacks without
  // making them depend on state (that would re-create the poll effect on every
  // change). A delta merges onto THIS. Written only by `applyTaskMap`, and
  // written synchronously so back-to-back deltas can't merge onto a stale base.
  const lastAppliedRef = useRef<Record<string, TaskDTO>>({});

  /* ---- Phase 2: batched persistence for high-frequency text edits ---- */
  // `overlay` = unconfirmed field patches (mine + peers', keyed by task) that are
  // re-applied after EVERY refetch, so a delayed DB write or an interim poll can
  // never revert a live edit. Each entry clears once the server value matches it
  // (or after OVERLAY_TTL_MS, a backstop for a sender that died before flushing).
  const overlayRef = useRef<Map<string, { patch: TaskEdit; at: number }>>(new Map());
  // `pendingEdits` = MY edits not yet written to Postgres; flushed on a debounce.
  const pendingEditsRef = useRef<Map<string, TaskEdit>>(new Map());
  const editFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest `flushEdits`, so a failed flush can re-arm its own retry without it
  // and `scheduleEditFlush` having to depend on each other.
  const flushEditsRef = useRef<() => Promise<void>>(async () => {});
  // Latest taskMap for the (possibly delayed) flush's expected-updatedAt token.
  const taskMapRef = useRef<Record<string, Task>>({});
  useEffect(() => void (taskMapRef.current = taskMap), [taskMap]);

  // Latest nodes list, so a delete can snapshot the removed node for undo.
  const nodesRef = useRef<TaskNode[]>([]);
  useEffect(() => void (nodesRef.current = nodes), [nodes]);

  // How the mounted canvas resolves which Section a card renders in. Registered
  // by CanvasEditor (see registerPlacement) and left null on the board views,
  // which have no sections — so the shared drag paths can ask about placement
  // without this context knowing what a canvas is.
  const placementRef = useRef<PlacementResolver | null>(null);
  const registerPlacement = useCallback((resolver: PlacementResolver | null) => {
    placementRef.current = resolver;
  }, []);

  // A fetched `sectionId → placement` map, when some view has one to lend (only
  // the project Boards view fetches it today). Empty is a working default: every
  // machine-made lane id NAMES its bucket, which is what `placementOfDerivedId`
  // reads — the map only adds hand-made sections sitting inside a group.
  const placementMapRef = useRef<PlacementMap>({});
  const registerPlacementMap = useCallback((map: PlacementMap) => {
    placementMapRef.current = map;
  }, []);

  // Buckets requested but not yet confirmed — see `fileTask`. A view that renders
  // by bucket reads these on top of the resolved pins, so a filed card appears
  // where it's going for the round trip rather than sitting in its old band.
  const [pendingPlacements, setPendingPlacements] = useState<
    Record<string, TaskPlacement>
  >({});

  // Tasks removed on the canvas but not yet committed to Postgres — kept alive
  // for the ~5s undo window (Gmail-style). `fetchAll` filters these ids so a
  // background poll can't resurrect the card; each timer fires the real DELETE
  // when its window lapses. `pendingDeletes` mirrors it for the toast.
  const pendingDeleteRef = useRef<
    Map<
      string,
      {
        task: Task;
        node: TaskNode | undefined;
        timer: ReturnType<typeof setTimeout>;
        mode: "delete" | "archive";
      }
    >
  >(new Map());
  const [pendingDeletes, setPendingDeletes] = useState<
    { id: string; title: string; mode: "delete" | "archive" }[]
  >([]);

  // Most recent arrow-key placement move (the ↑/→/↓ hover shortcuts), for its
  // undo toast. Unlike `pendingDeletes` this ISN'T a queue: a send commits
  // immediately (no grace window to defer), so there's nothing to accumulate —
  // each new send just overwrites the last, no debounce, same as `notice`.
  // `fromPin` is where it was pinned before the move, for `undoSend` to put it
  // back.
  const [pendingSend, setPendingSend] = useState<
    { id: string; title: string; to: TaskPlacement; fromPin: string | null } | null
  >(null);

  // Mirror of the open-modal stack so the (never re-armed) poll closure can
  // refresh every open task's thread when the cursor moves — no interval re-arm.
  const openTaskIdsRef = useRef<string[]>([]);
  useEffect(() => {
    openTaskIdsRef.current = openTaskIds;
  }, [openTaskIds]);

  // Which canvas (if any) CanvasEditor currently has mounted — same "let the
  // poll closure know what's on screen without re-arming it" trick as above,
  // just for one id instead of a stack (only one canvas is ever open).
  const [canvasNotes, setCanvasNotes] = useState<Record<string, Note[]>>({});
  const openCanvasIdRef = useRef<string | null>(null);

  // Mirror the modal stack to the URL (?tasks=id1,id2,…) without touching the
  // route path, so a refresh restores the exact stack. replaceState keeps this
  // out of history (no back-button spam); hydration happens in the load effect.
  const hydratedFromUrl = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined" || !hydratedFromUrl.current) return;
    const url = new URL(window.location.href);
    if (openTaskIds.length) url.searchParams.set("tasks", openTaskIds.join(","));
    else url.searchParams.delete("tasks");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [openTaskIds]);

  const refreshVersion = useCallback(async () => {
    try {
      const { v } = await api<{ v: string }>("/api/version");
      lastVersion.current = v;
    } catch {
      /* transient; next tick retries */
    }
  }, []);

  /** Push a COMPLETE task map into state: node list, live-edit overlay, map.
   *  Shared by the full fetch and the delta fetch so the two can never drift on
   *  the reconcile rules. Returns false if a mutation raced us and the snapshot
   *  was dropped. Mutates `map` (overlay re-application). */
  const applyTaskMap = useCallback(
    (map: Record<string, TaskDTO>, seq: number): boolean => {
      // A mutation started while the fetch was in flight — its snapshot may
      // predate that write, so don't apply it (nor touch the overlay). A later
      // reconcile (the mutation's own finally, or the poll) applies clean state.
      if (reconcileSeq.current !== seq) return false;
      const tasks = Object.values(map);
      setNodes(
        tasks.map((t) => ({
          id: t.id,
          parentId: t.parentId,
          boardId: t.boardId,
          status: t.status,
          statusSince: t.statusSince,
          position: t.position,
          createdAt: t.createdAt,
        })),
      );
      // Re-apply unconfirmed live edits (Phase 2) so a deferred DB write or an
      // interim poll never reverts them; drop each once the server reflects it.
      const now = Date.now();
      for (const [id, entry] of overlayRef.current) {
        const server = map[id];
        const applied =
          server &&
          Object.entries(entry.patch).every(
            ([k, v]) =>
              JSON.stringify((server as unknown as Record<string, unknown>)[k]) ===
              JSON.stringify(v),
          );
        if (!server || applied || now - entry.at > OVERLAY_TTL_MS) {
          overlayRef.current.delete(id);
        } else {
          map[id] = { ...server, ...entry.patch };
        }
      }
      // Carry the working fields forward: this map came from a list read, which
      // doesn't select them, and replacing an entry wholesale would drop the
      // copy a detail read had already put there. Absent ⇒ keep what we know;
      // an explicit `null` from a detail read still reads as "has none".
      const known = taskMapRef.current;
      for (const [id, row] of Object.entries(map)) {
        const before = known[id];
        if (!before) continue;
        for (const f of WORKING_FIELDS) {
          if (row[f] === undefined && before[f] !== undefined) {
            map[id] = { ...map[id], [f]: before[f] };
          }
        }
      }
      lastAppliedRef.current = map;
      setTaskMap(map);
      return true;
    },
    [],
  );

  const fetchAll = useCallback(async (): Promise<Record<string, Task> | undefined> => {
    // Snapshot the reconcile generation; if a mutation starts before this fetch
    // resolves, the snapshot may predate that write — skip applying it (a later
    // reconcile / the poll will apply clean state). Still return the fetched map
    // so return-value callers (e.g. `hydrate`) keep working.
    const seq = reconcileSeq.current;
    try {
      const { tasks: fetched, now } = await api<{ tasks: TaskDTO[]; now?: string }>(
        "/api/tasks?flat=1",
      );
      // Hide tasks still inside their delete undo window (see `deleteTask`), so
      // an interim poll doesn't flash the card back before the DELETE commits.
      const pend = pendingDeleteRef.current;
      const tasks = pend.size ? fetched.filter((t) => !pend.has(t.id)) : fetched;
      const map: Record<string, TaskDTO> = Object.fromEntries(tasks.map((t) => [t.id, t]));
      // Only advance the watermark if the snapshot was actually applied. If a
      // racing mutation made us drop it, `lastApplied` still holds the older
      // base, and moving the watermark would make the next delta skip
      // everything this response carried.
      if (applyTaskMap(map, seq) && now) lastSyncAt.current = now;
      return map;
    } catch (e) {
      console.error("[workspace] failed to load tasks", e);
      return undefined;
    }
  }, [applyTaskMap]);

  /** Fetch only what changed since the last sync and merge it in — the poll's
   *  path. The board is ~190 KB while a typical change is a single task, so
   *  re-downloading everything on each cursor move was the bulk of the egress
   *  bill (PLAT-403). Falls back to a full read with no watermark or on error. */
  const fetchDelta = useCallback(async (): Promise<void> => {
    const since = lastSyncAt.current;
    if (!since) {
      await fetchAll();
      return;
    }
    const seq = reconcileSeq.current;
    try {
      const { tasks: changed, ids, now } = await api<{
        tasks: TaskDTO[];
        ids: string[];
        now: string;
      }>(`/api/tasks?flat=1&since=${encodeURIComponent(since)}`);
      const pend = pendingDeleteRef.current;
      const alive = new Set(ids);
      const map: Record<string, TaskDTO> = {};
      // Carry forward everything the server still lists, then overwrite with the
      // rows it says changed. Anything absent from `ids` was deleted.
      for (const [id, t] of Object.entries(lastAppliedRef.current)) {
        if (alive.has(id) && !pend.has(id)) map[id] = t;
      }
      for (const t of changed) {
        if (!pend.has(t.id)) map[t.id] = t;
      }
      // Same rule as the full fetch: the watermark only moves if we applied.
      if (applyTaskMap(map, seq)) lastSyncAt.current = now;
    } catch (e) {
      console.error("[workspace] delta fetch failed — falling back to full", e);
      await fetchAll();
    }
  }, [fetchAll, applyTaskMap]);

  const fetchProjects = useCallback(async () => {
    try {
      const { projects } = await api<{ projects: Project[] }>("/api/projects");
      setProjects(projects);
    } catch (e) {
      console.error("[workspace] failed to load projects", e);
    }
  }, []);

  // Load one task's full activity log + comment thread. Used when a task is
  // opened, after posting/attaching, and by the poll so a comment Claude
  // leaves shows up in the open thread live.
  const loadLogs = useCallback((id: string) => {
    // Same reconcile generation the list reads snapshot: this response may
    // predate a write started after we asked, and it's also the ONLY read that
    // carries the working fields, so it can't just be skipped wholesale.
    const seq = reconcileSeq.current;
    api<{
      task: Task;
      logs: TaskLogEntry[];
      notes?: Note[];
      commits?: TaskCommit[];
    }>(`/api/tasks/${id}`)
      .then((r) => {
        setLogs((prev) => ({ ...prev, [id]: r.logs }));
        setNotes((prev) => ({ ...prev, [id]: r.notes ?? [] }));
        setCommits((prev) => ({ ...prev, [id]: r.commits ?? [] }));
        // Keep the task map fresh (code/phase/summaries may have changed) — but
        // under the SAME reconcile rules as `applyTaskMap`, which this used to
        // bypass entirely (TD-62). Without them, a detail read landing inside
        // the ~10s `editTaskLive` window wrote the stale server text back over
        // a description/title you were still typing, and re-seeding the editor
        // from it then persisted the old text over the new one. The thread
        // (logs/notes/commits) above is unconditional — it has no local edits
        // to lose, so a racing mutation is no reason to drop it.
        if (!r.task) return;
        const overlay = overlayRef.current.get(id)?.patch;
        // A write started after we asked, so this row may predate it. Don't drop
        // the response outright — it's the only carrier of the working fields,
        // and this is the read that fills them in when a modal opens. Merge it
        // MONOTONICALLY instead: fill fields we don't have, overwrite nothing.
        // The racing write's own reconcile applies the rest a moment later.
        const raced = reconcileSeq.current !== seq;
        const fromServer = raced
          ? Object.fromEntries(
              Object.entries(r.task).filter(
                ([k, v]) =>
                  v !== undefined &&
                  (taskMapRef.current[id] as unknown as Record<string, unknown> | undefined)?.[
                    k
                  ] === undefined,
              ),
            )
          : r.task;
        // The delta base too: `fetchDelta` carries unchanged rows forward from
        // here, so leaving the older copy in place would revert this row on the
        // next poll that doesn't happen to list it as changed. This one holds
        // SERVER truth only — never the overlay. `applyTaskMap` retires an
        // overlay entry once the server value matches it, and a carried-forward
        // row seeded with our own unwritten text would satisfy that check while
        // Postgres still had the old value.
        lastAppliedRef.current = {
          ...lastAppliedRef.current,
          [id]: { ...lastAppliedRef.current[id], ...fromServer },
        };
        // The DISPLAY map keeps the live edit on top of the fresh row.
        setTaskMap((prev) => ({ ...prev, [id]: { ...prev[id], ...fromServer, ...overlay } }));
      })
      .catch((e) => console.error("[workspace] failed to load task detail", e));
  }, []);

  // Load one canvas's stickies (open + resolved). Used when a canvas mounts,
  // and by the poll/remote-refresh loop while `openCanvasIdRef` names one.
  const loadCanvasNotes = useCallback((canvasId: string) => {
    // This replaces the whole list, so it needs the same generation guard as a
    // task read: a note the user just dragged or resolved has an optimistic
    // position/state that a snapshot taken before that PATCH would undo (the
    // sticky visibly snapping back until the next refetch).
    const seq = reconcileSeq.current;
    api<{ notes: Note[] }>(`/api/canvases/${canvasId}/notes`)
      .then((r) => {
        if (reconcileSeq.current !== seq) return;
        setCanvasNotes((prev) => ({ ...prev, [canvasId]: r.notes }));
      })
      .catch((e) => console.error("[workspace] failed to load canvas notes", e));
  }, []);

  const registerOpenCanvas = useCallback(
    (canvasId: string | null) => {
      openCanvasIdRef.current = canvasId;
      if (canvasId) loadCanvasNotes(canvasId);
    },
    [loadCanvasNotes],
  );

  /* ---- Cross-client "task data changed" signal (realtime hot path) ---- */
  // Local mutations notify subscribers; the canvas Liveblocks bridge broadcasts
  // them to peers in the room so their view updates instantly (vs the ≤2s poll).
  const localChangeListeners = useRef(new Set<(s: ChangeSignal) => void>());
  const subscribeLocalChange = useCallback((cb: (s: ChangeSignal) => void) => {
    localChangeListeners.current.add(cb);
    return () => void localChangeListeners.current.delete(cb);
  }, []);
  const emitLocalChange = useCallback((signal: ChangeSignal = { kind: "refetch" }) => {
    localChangeListeners.current.forEach((cb) => cb(signal));
  }, []);

  // Apply a peer's field delta directly to our taskMap (no DB read) and hold it
  // in the overlay so an interim refetch can't revert it before the peer's write
  // lands. Never persists — the author owns the eventual Postgres write.
  const applyRemotePatch = useCallback((id: string, patch: TaskEdit) => {
    overlayRef.current.set(id, { patch: { ...(overlayRef.current.get(id)?.patch ?? {}), ...patch }, at: Date.now() });
    setTaskMap((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }, []);

  // Reload triggered by a PEER's broadcast. Mirrors the poll body but is
  // debounced (coalesce bursts) and NEVER emits — otherwise A→B→A broadcasts
  // would ping-pong forever. Skips while a local mutation is in flight (its own
  // finally-refetch reconciles to the latest anyway).
  const remoteRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshFromRemote = useCallback(() => {
    if (remoteRefreshTimer.current) clearTimeout(remoteRefreshTimer.current);
    remoteRefreshTimer.current = setTimeout(() => {
      remoteRefreshTimer.current = null;
      if (inflight.current !== 0) return;
      Promise.all([fetchAll(), fetchProjects()])
        .then(() => {
          openTaskIdsRef.current.forEach((id) => loadLogs(id));
          if (openCanvasIdRef.current) loadCanvasNotes(openCanvasIdRef.current);
          return refreshVersion();
        })
        .catch((e) => console.error("[workspace] remote refresh failed", e));
    }, 150);
  }, [fetchAll, fetchProjects, refreshVersion, loadLogs, loadCanvasNotes]);

  // Initial load, then poll a tiny change-cursor (not the whole list) and
  // only re-fetch when it moves. Plus revalidate-on-focus.
  useEffect(() => {
    // The cursor folds in projects + boards, so refresh both, then resync
    // the cursor so our own reload doesn't look like a change next tick.
    const reload = () =>
      Promise.all([fetchAll(), fetchProjects()]).then(() => {
        openTaskIdsRef.current.forEach((id) => loadLogs(id));
        if (openCanvasIdRef.current) loadCanvasNotes(openCanvasIdRef.current);
        return refreshVersion();
      });
    // Hydrate the modal stack from the URL on first load, then reconcile.
    const hydrate = async () => {
      const initial = new URLSearchParams(window.location.search).get("tasks");
      const initialIds = initial ? initial.split(",").filter(Boolean) : [];
      try {
        const [loaded] = await Promise.all([fetchAll(), fetchProjects()]);
        // Drop ids for tasks that no longer exist so we don't render blank levels.
        const alive = initialIds.filter((id) => loaded?.[id]);
        if (alive.length) {
          setOpenTaskIds(alive);
          alive.forEach((id) => loadLogs(id));
        } else if (initialIds.length) {
          // The URL pointed only at gone/invalid tasks — strip the stale param.
          const url = new URL(window.location.href);
          url.searchParams.delete("tasks");
          window.history.replaceState(null, "", url.pathname + url.search + url.hash);
        }
      } finally {
        hydratedFromUrl.current = true;
        await refreshVersion();
      }
    };
    hydrate();

    // Self-scheduling rather than setInterval, so the gap can grow while
    // nothing is happening. `delay` resets the moment the board moves or the
    // rider comes back, so an active session still feels immediate.
    let delay = POLL_MIN_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const tick = async () => {
      let changed = false;
      // A mutation in flight will resync the cursor itself; a hidden tab has
      // nobody looking. Either way, skip the round-trip but keep the loop alive.
      if (inflight.current === 0 && !document.hidden) {
        try {
          const { v } = await api<{ v: string }>("/api/version");
          if (v !== lastVersion.current) {
            changed = true;
            lastVersion.current = v;
            // Delta, not the whole board — the cursor only says SOMETHING moved.
            await Promise.all([fetchDelta(), fetchProjects()]);
            // Keep every open task's thread current (e.g. a new Claude comment).
            openTaskIdsRef.current.forEach((id) => loadLogs(id));
            // Same for an open canvas's stickies — this is the fallback path for
            // a note resolved/moved from a surface with no Liveblocks room open
            // (the Notes page, MCP, Telegram): getChangeCursor folds in
            // task_notes, so this cursor still moves even without a broadcast.
            if (openCanvasIdRef.current) loadCanvasNotes(openCanvasIdRef.current);
          }
        } catch (e) {
          console.error("[workspace] version poll failed", e);
        }
      }
      // Something moved → stay sharp. Nothing did → ease off toward the ceiling.
      delay = changed ? POLL_MIN_MS : Math.min(delay * 2, POLL_MAX_MS);
      if (!stopped) timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);

    /** Back to a fast cadence and check now — the rider is looking again. */
    const wakeUp = () => {
      delay = POLL_MIN_MS;
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(tick, POLL_MIN_MS);
    };
    const onFocus = () => {
      wakeUp();
      if (inflight.current === 0) reload();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") wakeUp();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchAll, fetchDelta, fetchProjects, refreshVersion, loadLogs, loadCanvasNotes]);

  /** Optimistic update now, server call, then reconcile from the source.
   *  `onSuccess` runs with the server call's result after it resolves (e.g. to
   *  swap an optimistic temp row for the real one). Reconcile is deferred until
   *  no mutation is in flight; the `reconcileSeq` guard in `fetchAll` protects
   *  against a fetch that a later op raced. */
  const mutate = useCallback(
    async (
      optimistic: (() => void) | null,
      serverCall: () => Promise<unknown>,
      opts?: { onSuccess?: (result: unknown) => void },
    ) => {
      inflight.current++;
      reconcileSeq.current++;
      optimistic?.();
      try {
        const result = await serverCall();
        opts?.onSuccess?.(result);
      } catch (e) {
        console.error("[workspace] mutation failed", e);
        // Never fail silently: the finally-refetch below reverts the optimistic
        // update, and a card sliding back with no explanation is indistinguishable
        // from the app losing your change. A 409 gets the specific story (another
        // writer won); a 400 is a business rule the server can explain better than
        // we can, so it speaks for itself (e.g. "can't complete X: 3 subtasks
        // aren't done"); everything else gets the generic one.
        // One rule is actionable rather than just reportable: a completion held
        // up by unfinished subtasks. It gets a prompt with a way forward instead
        // of a dead-end notice — otherwise DELETE on a Review parent (which means
        // "complete") has no answer at all.
        const rule =
          e instanceof ApiError && e.status === 400 ? openSubtasksRule(e) : null;
        if (rule) setPendingComplete(rule);
        else
          setNotice(
            e instanceof ApiError && e.status === 409
              ? "This task changed elsewhere — reloaded with the latest version."
              : (e instanceof ApiError && e.status === 400 && ruleMessage(e)) ||
                "Couldn’t save that — reloaded the latest.",
          );
      } finally {
        inflight.current--;
        // Only the last op in a burst reconciles (fewer fetches); the guard in
        // `fetchAll` keeps that safe even if a new op starts mid-fetch.
        if (inflight.current === 0) {
          await fetchAll();
          // Our own write moved the cursor; sync it so the next poll tick
          // doesn't see a "change" and re-fetch redundantly.
          await refreshVersion();
          // Tell peers in the canvas room to refresh now (hot path).
          emitLocalChange();
        }
      }
    },
    [fetchAll, refreshVersion, emitLocalChange],
  );

  /**
   * POST a batch to `/api/tasks/bulk` — the ONE way this app sends bulk ops.
   *
   * `bulkApply` is best-effort by design: it runs each op independently, reports
   * per-op failures as `{ok:false}` in `results`, and answers 200 either way (the
   * MCP and Telegram callers read that body). Two traps come with it, and this
   * helper is where they're handled once instead of at every call site:
   *
   *   • **Silent truncation.** Anything past `MAX_BULK_OPS` is dropped with no
   *     `results` entry at all. Restamping a big section, or moving a deep
   *     subtree across boards, can exceed it. So the batch is CHUNKED here —
   *     sequentially, because ops read the state earlier ops wrote (`nextPosition`,
   *     parent existence), so the order has to hold.
   *   • **Silent partial failure.** A 200 with `ok:false` entries never throws, so
   *     callers saw success. Now it tells the user.
   *
   * Returns every result, INDEX-ALIGNED with `operations` — callers rely on that
   * to match a created task's new id back to the row that asked for it. Ops that
   * failed keep their slot (`ok:false`), so alignment survives a partial batch.
   */
  const bulk = useCallback(async (operations: unknown[]): Promise<OpResult[]> => {
    const results: OpResult[] = [];
    for (let i = 0; i < operations.length; i += MAX_BULK_OPS) {
      const { results: chunk, truncated } = await api<{
        results: OpResult[];
        truncated: boolean;
      }>("/api/tasks/bulk", {
        method: "POST",
        body: JSON.stringify({ operations: operations.slice(i, i + MAX_BULK_OPS) }),
      });
      results.push(...(chunk ?? []));
      // Chunking is sized to the server's cap, so this can't happen — if it ever
      // does the cap moved, and ops are being dropped on the floor again.
      if (truncated) console.error("[workspace] bulk truncated despite chunking");
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.error("[workspace] bulk ops failed", failed);
      setNotice(
        `${failed.length} of ${results.length} change${results.length === 1 ? "" : "s"} didn’t save — reloaded the latest.`,
      );
    }
    return results;
  }, []);

  /** Like `mutate`, but for project/board changes — reconciles the sidebar. */
  const mutateProjects = useCallback(
    async (serverCall: () => Promise<unknown>) => {
      inflight.current++;
      reconcileSeq.current++;
      try {
        await serverCall();
      } catch (e) {
        console.error("[workspace] project mutation failed", e);
        setNotice("Couldn’t save that — reloaded the latest.");
      } finally {
        inflight.current--;
        if (inflight.current === 0) {
          await Promise.all([fetchProjects(), fetchAll()]);
          await refreshVersion();
          emitLocalChange();
        }
      }
    },
    [fetchProjects, fetchAll, refreshVersion, emitLocalChange],
  );

  /* ---- Status changes ---- */
  function patchStatusLocal(id: string, status: TaskStatus) {
    const now = new Date().toISOString();
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, status, statusSince: now } : n)));
    setTaskMap((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], status, updatedAt: now } } : prev));
  }

  /**
   * PATCH a task. If the patch touches a content field (title, description,
   * …) and we know the task's current `updatedAt`, send it as our own
   * `X-Expected-Updated-At` header so the server rejects the write with a 409
   * if another writer changed the task first. Status-only patches send no
   * header → last-write-wins.
   *
   * NOT the standard `If-Match`: Vercel's edge evaluates HTTP preconditions
   * itself and turns a perfectly good response into a 412 PRECONDITION_FAILED
   * whenever the value doesn't match the response ETag — the write lands, but
   * the client sees an error. A custom header no intermediary interprets keeps
   * the conflict check ours alone. (Server side: /api/tasks/[id]/route.ts.)
   */
  function patchTask(id: string, patch: TaskEdit) {
    // Read the token from the ref, not the render's taskMap — a batched flush can
    // fire seconds later and must send the LATEST updatedAt to avoid a false 409.
    const token = taskMapRef.current[id]?.updatedAt;
    const guarded = token && CONTENT_FIELDS.some((f) => f in patch);
    return api<{ task?: TaskDTO }>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      ...(guarded ? { headers: { "X-Expected-Updated-At": token } } : {}),
    }).then((res) => {
      // Every write — even a status-only one — bumps the row's `updatedAt`
      // server-side. `mutate`/`flushEdits` only reconcile from the source once
      // ALL in-flight ops for this burst drain, so a second content edit fired
      // before that (e.g. importance right after a title save) would otherwise
      // reuse this now-stale token and 409 against its OWN prior write. Bump it
      // the moment each response lands so the next guarded write in the same
      // burst sees the fresh value.
      if (res?.task?.updatedAt) {
        setTaskMap((prev) =>
          prev[id] ? { ...prev, [id]: { ...prev[id], updatedAt: res.task!.updatedAt } } : prev,
        );
      }
      return res;
    });
  }

  /** Edit content fields on a task (conflict-guarded via `patchTask`). */
  function editTask(id: string, patch: TaskEdit) {
    mutate(
      () =>
        setTaskMap((prev) =>
          prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev,
        ),
      () => patchTask(id, patch),
    );
  }

  /** Toggle the current user in/out of a task's assignees — the SPACE hover
   *  shortcut on canvas task cards. No-op if we don't know who "me" is. */
  function toggleSelfAssignee(id: string) {
    if (!meId) return;
    const cur = taskMapRef.current[id]?.assigneeIds ?? [];
    const next = cur.includes(meId) ? cur.filter((a) => a !== meId) : [...cur, meId];
    editTask(id, { assigneeIds: next });
  }

  /**
   * Which bucket a card is in, as well as this client can tell it WITHOUT a
   * canvas: the target of a `fileTask` still in flight, else its pin — read
   * through a lent map when there is one, and otherwise out of the pin id itself,
   * since every lane the machine makes has a derived id that names its bucket
   * (`placementOfDerivedId`). A mounted canvas knows better and answers for
   * itself (`PlacementResolver.groupOf`); this is what makes DELETE mean the same
   * thing on the board views, which have no canvas to ask.
   */
  function placementOf(id: string): TaskPlacement {
    return (
      pendingPlacements[id] ??
      placementOfTask(
        id,
        taskMapRef.current,
        (child) => nodesRef.current.find((n) => n.id === child)?.parentId ?? null,
        placementMapRef.current,
      )
    );
  }

  /** Fire the deferred DELETE once a task's undo window has lapsed. */
  const commitDelete = useCallback(
    (id: string) => {
      const entry = pendingDeleteRef.current.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingDeleteRef.current.delete(id);
      setPendingDeletes((s) => s.filter((d) => d.id !== id));
      mutate(null, () =>
        entry.mode === "archive"
          ? api(`/api/tasks/${id}/archive`, {
              method: "POST",
              body: JSON.stringify({ archived: true }),
            })
          : api(`/api/tasks/${id}`, { method: "DELETE" }),
      );
    },
    [mutate],
  );

  /**
   * Delete a task with an undo window: drop it from view immediately, then
   * commit to Postgres after UNDO_WINDOW_MS unless `undoDelete` cancels first.
   * The removed node is snapshotted so undo can restore it.
   *
   * Finished work exits in TWO steps (`deletionOf`), so the irreversible-looking
   * step always takes a deliberate second press. A card that was never done
   * still deletes on the first press.
   *
   * What the two steps ARE depends on whether the surface has a DONE THIS WEEK
   * tray to park in, which is the one thing that differs between surfaces:
   *
   *   • Off the canvas (project Boards, kanban, table) — first Delete on a done
   *     card parks it in DONE THIS WEEK via `fileTask`, which owns the bucket
   *     resolution server-side; a second Delete from the tray archives it. A
   *     REVIEW card is accepted by that same press: marked done AND parked.
   *   • On the canvas — there is no tray (TD-87). A done card stays in its own
   *     board's lane wearing the green wash, and Delete archives it. A REVIEW
   *     card is marked done and left where it is, so the second press is what
   *     takes it off the board.
   *
   * Both read the card's current tray the same way — the canvas from its nodes,
   * everyone else from `placementOf` — and both ask `deletionOf`, so neither the
   * caller nor the keyboard shortcut has to know which surface it's on.
   */
  function deleteTask(id: string) {
    const task = taskMapRef.current[id];
    if (!task || pendingDeleteRef.current.has(id)) return;
    const placement = placementRef.current;
    const boardId = task.boardId ?? null;
    const tray = placement ? placement.groupOf(id) : trayOfPlacement(placementOf(id));
    // A mounted canvas has no DONE THIS WEEK tray to park into (TD-87), so on
    // the canvas a done card archives on this press instead of parking, and an
    // accepted REVIEW card is simply marked done and left in its lane.
    const canPark = !placement;
    const action = deletionOf(task.status, tray, { canPark });
    if (action === "park" || action === "complete") {
      // REVIEW → accept it: done AND parked in ONE write. `moveTask` sets
      // completedAt, stamps statusSince and records the status event alongside the
      // pin, so there's no second request to race the first (`mutate` doesn't
      // serialise — two writes fired in a tick land in whatever order the network
      // gives, and a refetch between them would show a half-applied card).
      const status = action === "complete" ? ("done" as const) : undefined;
      // Parking only happens off the canvas now, so there is no lane to pin to
      // client-side: let the server resolve the bucket, in the same write that
      // accepts a REVIEW card. Needs a board — the buckets are per-board lanes,
      // so a board-less task has nowhere to go.
      if (canPark && boardId) {
        void fileTask(id, boardId, "doneThisWeek", { status });
        return;
      }
      // Nowhere to park: on the canvas by design, and off it when the task has no
      // board (the buckets are per-board lanes). Either way an accepted card is
      // still accepted — it's marked done and stays where it is, and the next
      // press archives it as a done card.
      if (status) {
        mutate(
          () => patchStatusLocal(id, status),
          () =>
            api(`/api/tasks/${id}/complete`, {
              method: "POST",
              body: JSON.stringify({ done: true }),
            }),
        );
        return;
      }
    }
    // Any edit still sitting in the batch would PATCH a row that's gone: the
    // delete commits in UNDO_WINDOW_MS, the edit debounce runs for EDIT_FLUSH_MS.
    // Flushing rather than dropping keeps the value the undo snapshot carries.
    // Through the ref, not `flushEdits` itself — reading the memoized callback
    // from this plain function is what makes the React Compiler give up on it.
    if (pendingEditsRef.current.size) void flushEditsRef.current();
    const mode: "delete" | "archive" = action === "delete" ? "delete" : "archive";
    const node = nodesRef.current.find((n) => n.id === id);
    setTaskMap((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setNodes((prev) => prev.filter((n) => n.id !== id));
    const timer = setTimeout(() => commitDelete(id), UNDO_WINDOW_MS);
    pendingDeleteRef.current.set(id, { task, node, timer, mode });
    setPendingDeletes((s) => [...s.filter((d) => d.id !== id), { id, title: task.title, mode }]);
  }

  /** Cancel pending deletes and restore the tasks. With no id, undoes EVERY task
   *  still inside its window — the toast's Undo and the canvas Ctrl+Z both mean
   *  "put back what I just deleted", and a run of DELETE presses is one action to
   *  the person who made it, not N to be reversed one at a time (and the windows
   *  are lapsing while they press). Pass an id to undo just that one. Returns
   *  whether it undid anything. */
  const undoDelete = useCallback((id?: string): boolean => {
    const pend = pendingDeleteRef.current;
    const targets = id ? (pend.has(id) ? [id] : []) : [...pend.keys()];
    if (!targets.length) return false;
    const entries = targets.map((t) => [t, pend.get(t)!] as const);
    for (const [t, entry] of entries) {
      clearTimeout(entry.timer);
      pend.delete(t);
    }
    const undone = new Set(targets);
    setPendingDeletes((s) => s.filter((d) => !undone.has(d.id)));
    setTaskMap((prev) => {
      const next = { ...prev };
      for (const [t, entry] of entries) next[t] = entry.task;
      return next;
    });
    const restored = entries.map(([, entry]) => entry.node).filter((n): n is TaskNode => !!n);
    if (restored.length) {
      setNodes((prev) => [
        ...prev,
        ...restored.filter((n) => !prev.some((x) => x.id === n.id)),
      ]);
    }
    return true;
  }, []);

  // Flush any still-pending deletes on unmount (best-effort), so navigating away
  // inside the undo window doesn't silently drop the delete.
  useEffect(
    () => () => {
      for (const [id, { timer, mode }] of pendingDeleteRef.current) {
        clearTimeout(timer);
        const req =
          mode === "archive"
            ? api(`/api/tasks/${id}/archive`, {
                method: "POST",
                body: JSON.stringify({ archived: true }),
              })
            : api(`/api/tasks/${id}`, { method: "DELETE" });
        void req.catch(() => {});
      }
    },
    [],
  );

  /** Write all pending batched edits to Postgres now, cancelling the debounce.
   *  Called on the timer, on blur/close (via context), and when the tab hides. */
  const flushEdits = useCallback(async () => {
    if (editFlushTimer.current) {
      clearTimeout(editFlushTimer.current);
      editFlushTimer.current = null;
    }
    const edits = [...pendingEditsRef.current.entries()];
    if (!edits.length) return;
    pendingEditsRef.current.clear();
    inflight.current++;
    try {
      // Settled per task, not all-or-nothing: `Promise.all` rejects on the first
      // failure, which left the other tasks' verdicts unknown while the buffer
      // had already been cleared — so one task's conflict could discard another
      // task's keystrokes.
      const results = await Promise.allSettled(
        edits.map(([id, patch]) => patchTask(id, patch)),
      );
      let conflicted = false;
      let retrying = false;
      results.forEach((res, i) => {
        if (res.status === "fulfilled") return;
        const [id, patch] = edits[i];
        console.error("[workspace] edit flush failed", res.reason);
        if (res.reason instanceof ApiError && res.reason.status === 409) {
          // Another writer won. Dropping our buffered text is the point of the
          // guard — but the overlay has to go too, or the reload below would
          // leave OUR rejected text on screen while the toast claims the latest
          // version is showing.
          conflicted = true;
          overlayRef.current.delete(id);
        } else {
          // A transient failure is not a conflict, and these are keystrokes:
          // put the buffer back rather than silently discarding what was typed.
          // Anything typed since we cleared it is newer, so it wins the merge.
          retrying = true;
          pendingEditsRef.current.set(id, {
            ...patch,
            ...(pendingEditsRef.current.get(id) ?? {}),
          });
        }
      });
      if (retrying) {
        if (editFlushTimer.current) clearTimeout(editFlushTimer.current);
        editFlushTimer.current = setTimeout(
          () => void flushEditsRef.current(),
          EDIT_FLUSH_MS,
        );
      }
      if (conflicted)
        setNotice("This task changed elsewhere — reloaded with the latest version.");
      else if (retrying) setNotice("Couldn’t save your edit — retrying.");
    } finally {
      inflight.current--;
      await fetchAll(); // overlay reconciles: confirmed patches drop out
      await refreshVersion();
      emitLocalChange(); // peers refetch the now-persisted state
    }
    // patchTask is a stable hoisted declaration reading refs — no dep needed.
  }, [fetchAll, refreshVersion, emitLocalChange]);

  useEffect(() => void (flushEditsRef.current = flushEdits), [flushEdits]);

  const scheduleEditFlush = useCallback(() => {
    if (editFlushTimer.current) clearTimeout(editFlushTimer.current);
    editFlushTimer.current = setTimeout(() => void flushEdits(), EDIT_FLUSH_MS);
  }, [flushEdits]);

  /** Live edit for high-frequency text (title/description): apply optimistically,
   *  broadcast the delta so peers update instantly, and DEFER the Postgres write
   *  (batched ~10s / flushed on blur/close). Contrast `editTask`, which persists
   *  immediately — use this only for fields that change on every keystroke.
   *
   *  Both parts are optional because BOTH cost real work at 8 keystrokes/second:
   *
   *  • `optimistic: false` skips the `taskMap` write. That write changes
   *    `taskMap`'s identity, which is a dependency of `useSectionUnits` — so one
   *    character rebuilds the unit tree in EVERY section on the canvas (the
   *    TD-132 cascade, per keystroke). A caller that already renders the text
   *    from its own state, like the outline's rows, doesn't need it: the queued
   *    write and the overlay land it in `taskMap` at the flush instead.
   *  • `broadcast: false` skips the room event. A peer applying a patch pays the
   *    same cascade on THEIR canvas, so per-keystroke broadcasting is only worth
   *    it when someone is actually watching that text — the outline asks presence
   *    and passes false when you're editing alone, which is the common case.
   *
   *  The overlay is always set, so whichever path lands the value can't be
   *  reverted by an interim refetch. */
  function editTaskLive(
    id: string,
    patch: TaskEdit,
    { optimistic = true, broadcast = true }: { optimistic?: boolean; broadcast?: boolean } = {},
  ) {
    overlayRef.current.set(id, {
      patch: { ...(overlayRef.current.get(id)?.patch ?? {}), ...patch },
      at: Date.now(),
    });
    if (optimistic)
      setTaskMap((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
    if (broadcast) emitLocalChange({ kind: "patch", taskId: id, patch });
    pendingEditsRef.current.set(id, { ...(pendingEditsRef.current.get(id) ?? {}), ...patch });
    scheduleEditFlush();
  }

  // Durability for batched edits: persist immediately when the tab is hidden
  // (covers tab-switch / close in most browsers) and best-effort on unload.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flushEdits();
    };
    const onUnload = () => void flushEdits();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [flushEdits]);

  function start(id: string) {
    if (nodes.find((n) => n.id === id)?.status === "building") return;
    mutate(
      () => patchStatusLocal(id, "building"),
      () => patchTask(id, { status: "building" }),
    );
  }

  function toggleDone(id: string) {
    const nowDone = nodes.find((n) => n.id === id)?.status !== "done";
    mutate(
      () => patchStatusLocal(id, nowDone ? "done" : "todo"),
      () => api(`/api/tasks/${id}/complete`, { method: "POST", body: JSON.stringify({ done: nowDone }) }),
    );
  }

  /** Answer the pending prompt: close the branch bottom-up on the server (see
   *  `completeTask`'s `withSubtasks`), then reconcile. The optimistic step only
   *  marks the parent — the descendants arrive with the refetch, since the client
   *  doesn't know which of them were open. */
  function completeBranch(id: string) {
    setPendingComplete(null);
    mutate(
      () => patchStatusLocal(id, "done"),
      () =>
        api(`/api/tasks/${id}/complete`, {
          method: "POST",
          body: JSON.stringify({ done: true, withSubtasks: true }),
        }),
    );
  }

  function setStatus(id: string, status: TaskStatus) {
    if (nodes.find((n) => n.id === id)?.status === status) return;
    mutate(
      () => patchStatusLocal(id, status),
      () => patchTask(id, { status }),
    );
  }

  /** Archive every done task in scope (a board, a project, or all when omitted).
   *  Drops the visible done cards from view immediately, then persists +
   *  refetches to reconcile (the server cascades each to its subtree and also
   *  catches board-less project tasks the client can't match locally). */
  async function archiveAllDone(
    scope: { boardId?: string; projectId?: string } = {},
  ): Promise<number> {
    // Board ids in scope: the one board, every board of the project, or all.
    const projectBoardIds = scope.projectId
      ? new Set(
          (projects.find((p) => p.id === scope.projectId)?.boards ?? []).map((b) => b.id),
        )
      : null;
    const inScope = (boardId: string | null | undefined) =>
      scope.boardId
        ? boardId === scope.boardId
        : projectBoardIds
          ? boardId != null && projectBoardIds.has(boardId)
          : true;
    const doneIds = nodesRef.current
      .filter((n) => n.status === "done" && inScope(n.boardId))
      .map((n) => n.id);
    const drop = new Set(doneIds);
    if (drop.size) {
      setTaskMap((prev) => {
        const next = { ...prev };
        for (const id of drop) delete next[id];
        return next;
      });
      setNodes((prev) => prev.filter((n) => !drop.has(n.id)));
    }
    let archived = doneIds.length;
    try {
      const res = await api<{ archived: number }>(`/api/tasks/archive-done`, {
        method: "POST",
        body: JSON.stringify(scope),
      });
      archived = res.archived;
    } finally {
      await fetchAll();
      await refreshVersion();
      emitLocalChange();
    }
    return archived;
  }

  /* ---- Drag & drop: reorder / nest / cross-group ---- */
  function moveNode(dragId: string, targetId: string, pos: DropPos) {
    if (dragId === targetId) return;
    if (isDescendant(nodes, dragId, targetId)) return;
    const drag = nodes.find((n) => n.id === dragId);
    const target = nodes.find((n) => n.id === targetId);
    if (!drag || !target) return;

    // Cross-section drop (canvas): the target card renders in a DIFFERENT
    // section than the dragged one, so the whole subtree has to be re-pinned —
    // and re-homed when the target section sits on another board. The canvas
    // passes `placement` (it owns the resolution; see buildSectionMembership),
    // because a card's section is derived, not readable off the task alone.
    const placement = placementRef.current;
    if (placement) {
      const from = placement.sectionOf(dragId);
      const to = placement.sectionOf(targetId);
      if (to && from !== to) {
        moveNodeIntoSection(dragId, placement.pinFor(to), target.boardId ?? null, {
          targetId,
          pos,
          siblingIds: placement.membersOf(to),
        });
        return;
      }
    }

    if (pos === "inside") {
      mutate(
        () =>
          setNodes((prev) =>
            prev.map((n) => (n.id === dragId ? { ...n, parentId: targetId } : n)),
          ),
        () => api(`/api/tasks/${dragId}/move`, { method: "POST", body: JSON.stringify({ parentId: targetId }) }),
      );
      return;
    }

    // before/after: land the card at the drop index by RESTAMPING the run it was
    // dropped into with dense positions — not by interpolating a gap, which ties
    // make degenerate (see `insertRelative`).
    //
    // Which run depends on the surface, and it must be the one on SCREEN:
    //   • canvas — the target's section members at this parent. A section mixes
    //     statuses, so a same-status list would be neighbours the user can't see.
    //   • table  — same-parent, same-status rows, as rendered under its status
    //     headers.
    // That split also decides status: the table's rows ARE grouped into status
    // columns, so dropping into one means "put it in this column". A section is
    // not a status container, so a reorder there must leave status alone —
    // otherwise dragging a card past a Done one silently completes it.
    const section = placement?.sectionOf(targetId) ?? null;
    const members = section ? placement?.membersOf(section) : null;
    const adoptStatus = members ? undefined : target.status;
    const run = nodes
      .filter(
        (n) =>
          n.parentId === target.parentId &&
          (members ? members.has(n.id) : n.status === target.status),
      )
      .sort(compareTaskOrder);

    const currentIds = run.map((n) => n.id);
    const orderedIds = insertRelative(currentIds, dragId, targetId, pos);
    // Nothing to do: same sequence, same parent, same status (dropping a card
    // right back where it already sits).
    if (
      orderedIds.join() === currentIds.join() &&
      drag.parentId === target.parentId &&
      (adoptStatus === undefined || drag.status === adoptStatus)
    )
      return;
    const posById = new Map(orderedIds.map((id, i) => [id, i]));
    const byId = new Map(run.map((n) => [n.id, n]));
    // Only the cards that actually shift are written. A run restamped once is
    // already dense, so later reorders touch just the span that moved.
    const ops = orderedIds
      .filter((id) => id === dragId || byId.get(id)?.position !== posById.get(id))
      .map((id) => ({
        op: "move",
        id,
        target:
          id === dragId
            ? {
                position: posById.get(id),
                parentId: target.parentId,
                ...(adoptStatus ? { status: adoptStatus } : {}),
              }
            : { position: posById.get(id) },
      }));

    mutate(
      () =>
        setNodes((prev) =>
          prev.map((n) => {
            const position = posById.get(n.id);
            if (position === undefined) return n;
            return {
              ...n,
              position,
              ...(n.id === dragId
                ? { parentId: target.parentId, ...(adoptStatus ? { status: adoptStatus } : {}) }
                : {}),
            };
          }),
        ),
      () => bulk(ops),
    );
  }

  /**
   * Fling a card into one of the canvas's groups — the hover arrows' one path.
   *
   * THIS WEEK appends (this week's list is a queue you work down, so new arrivals
   * belong at the END); BACKLOG and LATER take the top, because what you just
   * decided to defer is the thing you'll want to see first when you come back to
   * the pile. INBOX is `laneFor` → null, i.e. simply unpinned.
   *
   * Without a mounted canvas (the project Boards view, a board's kanban) the same
   * arrows go through `fileTask`: the server resolves the bucket to a pin, so the
   * gesture works off canvas — it just can't place the card WITHIN the lane the
   * way the canvas does. The undo toast still works: a send is reversed by
   * re-pinning the card to the pin it had, which needs no canvas either.
   *
   * No-op when the card is already there, or when it has no board (the buckets
   * are per-board lanes, so there's nowhere to file it).
   */
  function sendToPlacement(id: string, to: TaskPlacement) {
    const placement = placementRef.current;
    const task = taskMap[id];
    if (!task) return;
    if (!placement) {
      const boardId = task.boardId ?? null;
      if (!boardId) return;
      if (placementOf(id) === to) return; // already there — same guard as below
      const fromPin = task.canvasSectionId ?? null;
      void fileTask(id, boardId, to);
      setPendingSend({ id, title: task.title, to, fromPin });
      return;
    }
    const boardId = task.boardId ?? null;
    const lane = placement.laneFor(to, boardId);
    if (to !== "inbox" && !lane) return; // no such group on this canvas
    const fromPin = placement.sectionOf(id);
    if (fromPin === lane) return;
    const siblingIds = placement.membersOf(lane);
    // "Top of the list" = insert before the first top-level card already there.
    // With an empty lane there's nothing to sit before, so it appends either way.
    const first = nodes
      .filter((n) => n.parentId === null && n.id !== id && siblingIds.has(n.id))
      .sort(compareTaskOrder)[0]?.id;
    moveNodeIntoSection(id, lane, boardId, {
      ...(to !== "thisWeek" && first
        ? { targetId: first, pos: "before" as const }
        : {}),
      siblingIds,
    });
    setPendingSend({ id, title: task.title, to, fromPin });
  }

  // Put a sent card back where it came from — the send-undo toast's button.
  // Reversing precisely isn't the point (this mirrors `sendToPlacement` itself,
  // which only ever appends/tops a lane rather than restoring an exact index);
  // getting it back into the right group is what "oops, wrong arrow" needs.
  function undoSend() {
    const pending = pendingSend;
    if (!pending) return;
    const task = taskMap[pending.id];
    if (task) moveNodeIntoSection(pending.id, pending.fromPin, task.boardId ?? null);
    setPendingSend(null);
  }

  const clearPendingSend = useCallback(() => setPendingSend(null), []);

  // Move a task into a canvas Section — possibly one on a different board.
  //
  // `targetPin` is what to WRITE, not where it lands visually: a section node id
  // pins the task there, and **null unpins it**, which is how a task belongs to
  // an INBOX lane (a lane shows its board's unpinned tasks, so being in one is
  // the absence of a pin, not a pin to the lane). Only the dragged root is
  // re-pinned — descendants inherit their parent's placement, so re-pinning them
  // would be redundant and would strand them if the parent moved again.
  //
  // The board move still has to cascade to the whole subtree, since boardId is
  // real per-task state. `opts.targetId`/`pos` place the root relative to a card
  // (before/after/inside); omit them to append at the end. `opts.siblingIds`
  // carries the target section's current members from the canvas — position math
  // needs them because membership is derived and can't be read off a task.
  // One /api/tasks/bulk batch.
  function moveNodeIntoSection(
    dragId: string,
    targetPin: string | null,
    targetBoardId: string | null,
    opts?: {
      targetId?: string;
      pos?: DropPos;
      siblingIds?: Set<string>;
      /** Change the card's status in the SAME write as the move — one request, so
       *  the two can't land out of order. DELETE accepting a review card uses it
       *  (done + parked); `moveTask` handles completedAt and the status event. */
      status?: TaskStatus;
    },
  ) {
    const rel =
      opts?.targetId && opts.pos ? { targetId: opts.targetId, pos: opts.pos } : undefined;
    const status = opts?.status;
    const drag = nodes.find((n) => n.id === dragId);
    if (!drag) return;
    if (rel && (rel.targetId === dragId || isDescendant(nodes, dragId, rel.targetId))) return;

    // The subtree = the dragged task plus every descendant (any depth).
    const subtree: string[] = [dragId];
    for (let i = 0; i < subtree.length; i++) {
      for (const n of nodes) if (n.parentId === subtree[i]) subtree.push(n.id);
    }
    const inSubtree = new Set(subtree);
    const boardChanged = drag.boardId !== targetBoardId;

    // Siblings within the TARGET section under a given parent (position-ordered),
    // excluding the dragged subtree so its own rows never skew the math. Falls
    // back to pin equality when the canvas didn't supply its members (e.g. a
    // board view calling in).
    const members = opts?.siblingIds;
    const inTarget = (id: string) =>
      members ? members.has(id) : (taskMap[id]?.canvasSectionId ?? null) === targetPin;
    const sectionSiblings = (parentId: string | null) =>
      nodes
        .filter((n) => !inSubtree.has(n.id) && n.parentId === parentId && inTarget(n.id))
        .sort(compareTaskOrder);

    let parentId: string | null;
    let position: number;
    // `restamp` carries the target run's new dense positions when the drop was
    // aimed BETWEEN two cards. Appends don't need it — the end of a run is
    // unambiguous — but an insert does: interpolating a gap is degenerate
    // whenever the neighbours tie, which is routine here (see `insertRelative`).
    let restamp: Map<string, number> | null = null;
    if (rel?.pos === "inside") {
      parentId = rel.targetId;
      const sibs = sectionSiblings(parentId);
      position = (sibs[sibs.length - 1]?.position ?? 0) + 1;
    } else if (rel) {
      const target = nodes.find((n) => n.id === rel.targetId);
      if (!target) return;
      parentId = target.parentId;
      const sibs = sectionSiblings(parentId);
      const orderedIds = insertRelative(
        sibs.map((n) => n.id),
        dragId,
        rel.targetId,
        rel.pos,
      );
      restamp = new Map(orderedIds.map((id, i) => [id, i]));
      position = restamp.get(dragId)!;
    } else {
      parentId = null;
      const sibs = sectionSiblings(null);
      position = (sibs[sibs.length - 1]?.position ?? 0) + 1;
    }

    // No-op guard: same pin, same spot, same board — unless there's a status to
    // write, which is a real change even when nothing moves.
    const dragPin = taskMap[dragId]?.canvasSectionId ?? null;
    if (
      !status &&
      !boardChanged &&
      dragPin === targetPin &&
      drag.parentId === parentId &&
      drag.position === position
    )
      return;

    // Build the bulk batch. `canvasSectionId` is a scalar column, so re-pinning
    // is a plain assignment — no read-modify-write of a shared customFields bag,
    // and nothing for a concurrent writer to clobber. Only the root is re-pinned;
    // descendants follow it by inheritance, so any pin THEY carry from an earlier
    // drag is cleared to keep them with their parent.
    //
    // The root's pin rides on its own `move` op below rather than a separate
    // `update`: `moveTask` CLEARS the pin when the board changes unless the call
    // states one, so a pin written by an earlier op in the batch was undone by the
    // move that followed it — a cross-board drop landed in the INBOX lane instead
    // of the section it was dropped on. One op, whole intent.
    const ops: unknown[] = [];
    for (const id of subtree) {
      if (id === dragId) continue;
      if ((taskMap[id]?.canvasSectionId ?? null) !== null)
        ops.push({ op: "update", id, patch: { canvasSectionId: null } });
    }
    if (boardChanged) {
      for (const id of subtree) {
        if (id === dragId) continue;
        // Keep each descendant's own position — moveTask would otherwise default
        // it to the end of its status group and scramble sibling order.
        const n = nodes.find((x) => x.id === id);
        ops.push({ op: "move", id, target: { boardId: targetBoardId, position: n?.position } });
      }
    }
    ops.push({
      op: "move",
      id: dragId,
      target: {
        parentId,
        position,
        canvasSectionId: targetPin,
        ...(boardChanged ? { boardId: targetBoardId } : {}),
        ...(status ? { status } : {}),
      },
    });
    // Restamp the rest of the target run, so the index the card was dropped at is
    // a real position rather than a tie. Only cards that actually shift are
    // written; a run restamped once is dense, so later inserts touch only the
    // span that moved.
    if (restamp) {
      for (const [id, p] of restamp) {
        if (id === dragId) continue;
        if (nodes.find((n) => n.id === id)?.position === p) continue;
        ops.push({ op: "move", id, target: { position: p } });
      }
    }

    mutate(
      () => {
        if (status) patchStatusLocal(dragId, status);
        setTaskMap((prev) => {
          const next = { ...prev };
          for (const id of subtree) {
            const t = next[id];
            if (!t) continue;
            next[id] = {
              ...t,
              canvasSectionId: id === dragId ? targetPin : null,
              ...(boardChanged ? { boardId: targetBoardId } : {}),
            };
          }
          return next;
        });
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id === dragId)
              return { ...n, parentId, position, ...(boardChanged ? { boardId: targetBoardId } : {}) };
            if (boardChanged && inSubtree.has(n.id)) return { ...n, boardId: targetBoardId };
            const restamped = restamp?.get(n.id);
            if (restamped !== undefined) return { ...n, position: restamped };
            return n;
          }),
        );
      },
      () => bulk(ops),
    );
  }

  function dropToGroup(dragId: string, status: TaskStatus) {
    const drag = nodes.find((n) => n.id === dragId);
    if (!drag) return;
    const maxPos = Math.max(
      0,
      ...nodes.filter((n) => n.parentId === null && n.status === status).map((n) => n.position),
    );
    mutate(
      () =>
        setNodes((prev) =>
          prev.map((n) =>
            n.id === dragId
              ? { ...n, parentId: null, status, position: maxPos + 1, statusSince: new Date().toISOString() }
              : n,
          ),
        ),
      () => api(`/api/tasks/${dragId}/move`, { method: "POST", body: JSON.stringify({ parentId: null, status }) }),
    );
  }

  /* ---- Move onto a board (kanban card drop) ---- */
  function moveToBoard(id: string, boardId: string, status?: TaskStatus) {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    if (node.boardId === boardId && (status === undefined || node.status === status)) return;
    const now = new Date().toISOString();
    const nextStatus = status ?? node.status;
    // End of the target board+status column.
    const maxPos = Math.max(
      0,
      ...nodes
        .filter((n) => n.boardId === boardId && n.parentId === null && n.status === nextStatus)
        .map((n) => n.position),
    );
    mutate(
      () => {
        setNodes((prev) =>
          prev.map((n) =>
            n.id === id
              ? {
                  ...n,
                  boardId,
                  parentId: null,
                  status: nextStatus,
                  statusSince: nextStatus !== n.status ? now : n.statusSince,
                  position: maxPos + 1,
                }
              : n,
          ),
        );
        // Mirror moveTask's rule: changing board drops any canvas pin, since the
        // pinned Section belongs to the board we just left. Without this the card
        // would linger in that Section until the next refetch.
        if (node.boardId !== boardId)
          setTaskMap((prev) =>
            prev[id] ? { ...prev, [id]: { ...prev[id], canvasSectionId: null } } : prev,
          );
      },
      () =>
        api(`/api/tasks/${id}/move`, {
          method: "POST",
          body: JSON.stringify({ boardId, parentId: null, status: nextStatus }),
        }),
    );
  }

  /**
   * File a card on a board and in a bucket at once — one `move` write, since
   * moving boards and re-filing are the same server operation and the pin has to
   * be resolved against the NEW board (a Section belongs to one board).
   *
   * `opts.at` places it EXACTLY where it was dropped (see `PlaceAt`) instead of
   * appending it to the end of the column — the project Boards view's card-on-card
   * drop. Without it the card lands last, which is what dropping on the column's
   * empty space means.
   *
   * The optimistic half can't cover the pin — that's the server's to compute — so
   * instead the requested bucket is published as a `pendingPlacements` override
   * for as long as the write is in flight, and a view that renders by bucket shows
   * the card there meanwhile. Kept HERE rather than in the caller so every path
   * into this function (a drop, an arrow send, a DELETE parking a done card) gets
   * the same instant feedback. Status is left alone — a bucket is not a status, and
   * filing a card must never silently complete or restart it.
   */
  async function fileTask(
    id: string,
    boardId: string,
    placement: TaskPlacement,
    opts?: { status?: TaskStatus; at?: PlaceAt },
  ) {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const boardChanged = node.boardId !== boardId;
    setPendingPlacements((prev) => ({ ...prev, [id]: placement }));
    try {
      await fileTaskWrite(id, boardId, boardChanged, placement, opts?.status, opts?.at);
    } finally {
      // Clear it either way: on success the refetched pin says the same thing, and
      // on failure the card belongs back wherever the server still thinks it is.
      setPendingPlacements((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  /**
   * `fileTask` for a SET of cards, in one bulk batch — what a column sweep needs
   * ("Clear Done" on a band's board column files every done card in it into DONE
   * THIS WEEK).
   *
   * One batch rather than N calls to `fileTask`: each of those is its own request
   * AND its own `mutate`, so twenty done cards would mean twenty writes and
   * twenty refetches racing each other. Sweeping is bounded by the column, not by
   * anything the user picked one at a time, so the batch is the honest shape.
   *
   * No `boardId` argument: every card is already on the board whose column it's
   * rendered in, so this never moves a card between boards — and stating a board
   * on a `move` is what makes the server recompute (and possibly clear) a pin.
   * Status is left alone for the same reason `fileTask` leaves it alone: a bucket
   * is not a status.
   */
  async function fileTasks(ids: string[], placement: TaskPlacement) {
    if (!ids.length) return;
    setPendingPlacements((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = placement;
      return next;
    });
    try {
      await mutate(null, () =>
        bulk(ids.map((id) => ({ op: "move", id, target: { placement } }))),
      );
    } finally {
      setPendingPlacements((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
    }
  }

  /** The write half of `fileTask`, split out so the override above wraps it. */
  async function fileTaskWrite(
    id: string,
    boardId: string,
    boardChanged: boolean,
    placement: TaskPlacement,
    status?: TaskStatus,
    at?: PlaceAt,
  ) {
    if (at) return fileTaskAtWrite(id, boardId, boardChanged, placement, status, at);
    await mutate(
      () => {
        // `status` rides along so completing and filing are ONE write (see
        // `deleteTask`); `moveTask` sets completedAt and records the status event.
        if (status) patchStatusLocal(id, status);
        if (boardChanged)
          setNodes((prev) =>
            prev.map((n) => (n.id === id ? { ...n, boardId, parentId: null } : n)),
          );
      },
      () =>
        api(`/api/tasks/${id}/move`, {
          method: "POST",
          body: JSON.stringify({
            boardId,
            ...(boardChanged ? { parentId: null } : {}),
            ...(status ? { status } : {}),
            placement,
          }),
        }),
    );
  }

  /**
   * `fileTaskWrite` with an INDEX: the card lands next to the card it was dropped
   * on rather than at the end of the column.
   *
   * The index is made real by RESTAMPING the destination run with dense
   * positions, exactly as `moveNode`/`moveNodeIntoSection` do — see `PlaceAt` for
   * why interpolating a gap can't work here. So this is one `/api/tasks/bulk`
   * batch rather than one move: the dragged card carries board + bucket +
   * position together (a board change clears a pin the caller didn't state, so
   * splitting them would undo the filing), and each neighbour that actually
   * shifts carries its new position. A run restamped once is dense, so later
   * drops touch only the span that moved.
   */
  async function fileTaskAtWrite(
    id: string,
    boardId: string,
    boardChanged: boolean,
    placement: TaskPlacement,
    status: TaskStatus | undefined,
    at: PlaceAt,
  ) {
    const orderedIds = insertRelative(at.orderedIds, id, at.targetId, at.pos);
    // Dropped right back where it already sits, on the same board: nothing to
    // write. (A different band always changes the sequence — the card isn't in
    // that column's run to begin with.)
    if (!boardChanged && !status && orderedIds.join() === at.orderedIds.join())
      return;
    const posById = new Map(orderedIds.map((x, i) => [x, i]));
    const position = posById.get(id) ?? orderedIds.length;
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const ops: unknown[] = [
      {
        op: "move",
        id,
        target: {
          boardId,
          placement,
          position,
          ...(boardChanged ? { parentId: null } : {}),
          ...(status ? { status } : {}),
        },
      },
    ];
    for (const [otherId, p] of posById) {
      if (otherId === id) continue;
      if (byId.get(otherId)?.position === p) continue;
      ops.push({ op: "move", id: otherId, target: { position: p } });
    }

    await mutate(
      () => {
        if (status) patchStatusLocal(id, status);
        setNodes((prev) =>
          prev.map((n) => {
            const p = posById.get(n.id);
            if (n.id === id)
              return {
                ...n,
                position,
                ...(boardChanged ? { boardId, parentId: null } : {}),
              };
            return p !== undefined && p !== n.position ? { ...n, position: p } : n;
          }),
        );
      },
      () => bulk(ops),
    );
  }

  /* ---- Projects & boards ---- */
  const createProject = async (input: {
    name: string;
    code?: string;
    color?: string;
    gitFolder?: string;
    description?: string;
    members?: string[];
  }): Promise<Project | null> => {
    let created: Project | null = null;
    await mutateProjects(async () => {
      const res = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(input),
      });
      created = res.project;
    });
    return created;
  };
  const renameProject = (
    id: string,
    patch: {
      name?: string;
      code?: string;
      color?: string;
      image?: string | null;
      gitFolder?: string | null;
      description?: string | null;
      members?: string[];
    },
  ) =>
    mutateProjects(() =>
      api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    );
  const uploadProjectAvatar = (projectId: string, blob: Blob) =>
    mutateProjects(async () => {
      const form = new FormData();
      form.append("file", blob, "project.jpg");
      const res = await fetch(`/api/projects/${projectId}/avatar`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`project avatar upload failed (${res.status})`);
    });
  const deleteProject = (id: string) =>
    mutateProjects(() => api(`/api/projects/${id}`, { method: "DELETE" }));
  const createBoard = async (
    projectId: string,
    input: {
      name: string;
      code?: string;
      color?: string;
      gitFolder?: string;
      description?: string;
    },
  ): Promise<Board | null> => {
    let created: Board | null = null;
    await mutateProjects(async () => {
      const res = await api<{ board: Board }>("/api/boards", {
        method: "POST",
        body: JSON.stringify({ projectId, ...input }),
      });
      created = res.board;
    });
    return created;
  };
  const renameBoard = (
    id: string,
    patch: {
      name?: string;
      code?: string;
      color?: string;
      image?: string | null;
      gitFolder?: string | null;
      description?: string | null;
    },
  ) =>
    mutateProjects(() =>
      api(`/api/boards/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    );
  const uploadBoardAvatar = (boardId: string, blob: Blob) =>
    mutateProjects(async () => {
      // Multipart upload — don't route through `api` (it forces a JSON header).
      const form = new FormData();
      form.append("file", blob, "board.jpg");
      const res = await fetch(`/api/boards/${boardId}/avatar`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`board avatar upload failed (${res.status})`);
    });
  const deleteBoard = (id: string) =>
    mutateProjects(() => api(`/api/boards/${id}`, { method: "DELETE" }));
  const reorderBoards = (projectId: string, orderedIds: string[]) => {
    // Optimistically re-order the local board array so the Boards view and
    // sidebar update instantly; mutateProjects refetches to reconcile.
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId || !p.boards) return p;
        const byId = new Map(p.boards.map((b) => [b.id, b]));
        const ordered = orderedIds
          .map((id) => byId.get(id))
          .filter((b): b is Board => !!b);
        const rest = p.boards.filter((b) => !orderedIds.includes(b.id));
        return { ...p, boards: [...ordered, ...rest] };
      }),
    );
    mutateProjects(() =>
      api("/api/boards/reorder", {
        method: "POST",
        body: JSON.stringify({ projectId, orderedIds }),
      }),
    );
  };

  /* ---- Create ---- */
  function addTask(
    status: TaskStatus,
    title: string,
    boardId: string | null = null,
    placement?: TaskPlacement,
  ) {
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
    const maxPos = Math.max(
      0,
      ...nodes
        .filter((n) => n.parentId === null && n.status === status && n.boardId === boardId)
        .map((n) => n.position),
    );
    mutate(
      () => {
        setTaskMap((prev) => ({
          ...prev,
          [tempId]: {
            id: tempId,
            title,
            status,
            assigneeIds: [],
            boardId,
            updatedAt: now,
            // Placeholder pin so a view that groups by bucket shows the new card
            // in the bucket it was typed into, rather than flashing in INBOX for
            // a round trip. Only the PREFIX is meaningful (`placementOfDerivedId`
            // reads it); the real pin is the server's to compute and lands with
            // the response below. Display-only, and it never leaves the client —
            // the create request carries `placement`, not this.
            ...(placement && placement !== "inbox"
              ? {
                  canvasSectionId:
                    placement === "thisWeek" ? "wk-pending" : `${placement}-pending`,
                }
              : {}),
          },
        }));
        setNodes((prev) => [
          ...prev,
          { id: tempId, parentId: null, boardId, status, statusSince: now, position: maxPos + 1, createdAt: now },
        ]);
      },
      () =>
        api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            title,
            status,
            assigneeIds: [],
            boardId,
            ...(placement ? { placement } : {}),
          }),
        }),
      {
        // Swap the optimistic temp row for the real one in a single commit — no
        // disappear/remount window (the deferred reconcile would otherwise drop
        // the temp id before/until the real row is fetched). Position et al. are
        // corrected by the next reconcile.
        onSuccess: (result) => {
          const real = (result as { task?: Task }).task;
          if (!real?.id) return;
          setTaskMap((prev) => {
            if (!prev[tempId]) return prev;
            const next = { ...prev };
            delete next[tempId];
            next[real.id] = real;
            return next;
          });
          setNodes((prev) => prev.map((n) => (n.id === tempId ? { ...n, id: real.id } : n)));
        },
      },
    );
  }

  // Create a task inside a canvas Section. `canvasSectionId` pins it there —
  // pass **null** for an INBOX lane (a lane shows its board's unpinned tasks, so
  // pinning would take the card straight back out of it) and for a subtask, which
  // inherits its parent's placement. Mirrors addTask's optimistic temp-id →
  // real-id swap; `parentId` set makes it a subtask. `siblingIds` is the target
  // Section's current members, for end-of-list position math.
  function addSectionTask(input: {
    title: string;
    canvasSectionId: string | null;
    boardId: string | null;
    parentId?: string | null;
    siblingIds?: Set<string>;
    insertBefore?: string | null;
  }) {
    const { title, canvasSectionId, boardId, siblingIds } = input;
    const parentId = input.parentId ?? null;
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
    // This card's sibling group as RENDERED: same parent, same section, in the
    // canonical order — the run both the append and the insert are measured
    // against.
    const run = nodes
      .filter(
        (n) =>
          n.parentId === parentId &&
          (siblingIds
            ? siblingIds.has(n.id)
            : (taskMap[n.id]?.canvasSectionId ?? null) === canvasSectionId),
      )
      .sort(compareTaskOrder);
    // Composed in the gap above a card? Then the whole run is RESTAMPED densely
    // with the new card spliced in — the same thing a drop does, and for the same
    // reason: a section mixes statuses, so its cards routinely share a position
    // and the midpoint of two equal positions IS that position (see
    // `insertRelative`). Plain appends keep the cheap max+1 and touch nothing else.
    const at = input.insertBefore ? run.findIndex((n) => n.id === input.insertBefore) : -1;
    const inserting = at !== -1;
    const position = inserting
      ? at
      : Math.max(0, ...run.map((n) => n.position)) + 1;
    // The WHOLE run is restamped, not just the tail: positions are minted per
    // (status, parent) and never renumbered, so a section's run is often sparse or
    // tied — leaving the cards above the gap on their old keys could sort them
    // below the new one. Ops are filtered to the cards that actually change, so a
    // run already dense costs only the shove down.
    const shifted = inserting
      ? run.map((n, i) => ({ id: n.id, position: i < at ? i : i + 1 }))
      : [];
    const restamp = new Map(shifted.map((r) => [r.id, r.position]));
    mutate(
      () => {
        setTaskMap((prev) => ({
          ...prev,
          [tempId]: {
            id: tempId,
            title,
            status: "backlog",
            assigneeIds: [],
            boardId,
            canvasSectionId,
            updatedAt: now,
          },
        }));
        setNodes((prev) => [
          ...prev.map((n) => {
            const p = restamp.get(n.id);
            return p === undefined ? n : { ...n, position: p };
          }),
          { id: tempId, parentId, boardId, status: "backlog", statusSince: now, position, createdAt: now },
        ]);
      },
      async () => {
        const result = await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            title,
            status: "backlog",
            assigneeIds: [],
            boardId,
            parentId,
            canvasSectionId,
            position,
          }),
        });
        // The new row already holds its slot, so this batch is the shove down —
        // after the create, so a failure there leaves the order untouched.
        const ops = shifted
          .filter(({ id, position }) => run.find((n) => n.id === id)?.position !== position)
          .map(({ id, position }) => ({ op: "move", id, target: { position } }));
        if (ops.length) await bulk(ops);
        return result;
      },
      {
        onSuccess: (result) => {
          const real = (result as { task?: Task }).task;
          if (!real?.id) return;
          setTaskMap((prev) => {
            if (!prev[tempId]) return prev;
            const next = { ...prev };
            delete next[tempId];
            next[real.id] = real;
            return next;
          });
          setNodes((prev) => prev.map((n) => (n.id === tempId ? { ...n, id: real.id } : n)));
        },
      },
    );
  }

  /* ---- Open detail (lazily loads the activity log) ---- */
  // Push a new modal onto the stack. If the task is already open somewhere in
  // the stack, pop back to it (prevents duplicate levels and navigation cycles).
  const openTask = useCallback(
    (id: string) => {
      setOpenTaskIds((s) =>
        s.includes(id) ? s.slice(0, s.indexOf(id) + 1) : [...s, id],
      );
      loadLogs(id);
    },
    [loadLogs],
  );

  /* ---- Create a subtask, then open it stacked on top ---- */
  // The POST returns the created row with its real id, so we open that (avoids
  // the temp-id reconciliation problem plain optimistic creates would have).
  async function addSubtask(parentId: string, title: string) {
    const text = title.trim();
    if (!text) return;
    const { task } = await api<{ task: Task }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: text,
        status: "backlog",
        assigneeIds: [],
        boardId: taskMap[parentId]?.boardId ?? null,
        parentId,
      }),
    });
    await fetchAll();
    await refreshVersion();
    emitLocalChange();
    openTask(task.id);
  }

  /* ---- Comments (post to a task's conversation thread) ---- */
  // Optimistically append the note (attributed to "You"), POST it, then
  // reload the thread so the temp entry is replaced by the server row.
  async function addComment(id: string, message: string) {
    const text = message.trim();
    if (!text) return;
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
    await mutate(
      () => {
        setLogs((prev) => ({
          ...prev,
          [id]: [
            ...(prev[id] ?? []),
            { id: tempId, at: now, kind: "comment", message: text, author: "You" },
          ],
        }));
        setTaskMap((prev) =>
          prev[id]
            ? {
                ...prev,
                [id]: {
                  ...prev[id],
                  commentCount: (prev[id].commentCount ?? 0) + 1,
                  updatedAt: now,
                },
              }
            : prev,
        );
      },
      () =>
        api(`/api/tasks/${id}/comments`, {
          method: "POST",
          body: JSON.stringify({ message: text }),
        }),
    );
    loadLogs(id); // reconcile the temp entry with the server's stored comment
  }

  /* ---- Workflow: lock / notes / summaries ---- */

  // Lock the code (freeze it) and assign the task to me — the handoff side
  // effect behind every Copy-prompt click. Idempotent, so repeat clicks are
  // free; the modal fires this and ignores the prompt it returns (it builds its
  // own client-side, so the clipboard never waits on the network).
  async function lockTask(id: string): Promise<string> {
    const res = await api<{ task: Task; prompt: string }>(
      `/api/tasks/${id}/lock`,
      { method: "POST" },
    );
    setTaskMap((prev) =>
      prev[id] ? { ...prev, [id]: { ...prev[id], ...res.task } } : prev,
    );
    return res.prompt;
  }

  // Optimistically append a temp row (rendered with a small "saving" spinner),
  // POST it, then reload so the temp entry is replaced by the server row.
  async function addNote(
    id: string,
    input: { note: string; type?: NoteType; tags?: string[] },
  ) {
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
    await mutate(
      () =>
        setNotes((prev) => ({
          ...prev,
          [id]: [
            ...(prev[id] ?? []),
            {
              id: tempId,
              taskId: id,
              canvasId: null,
              note: input.note,
              type: input.type,
              tags: input.tags ?? [],
              author: meName,
              createdAt: now,
            },
          ],
        })),
      () =>
        api(`/api/tasks/${id}/notes`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
    );
    loadLogs(id);
  }

  // Optimistically flip a note's resolvedAt, PATCH it, then reconcile.
  async function resolveNote(taskId: string, noteId: string, resolved: boolean) {
    const now = new Date().toISOString();
    await mutate(
      () =>
        setNotes((prev) => ({
          ...prev,
          [taskId]: (prev[taskId] ?? []).map((n) =>
            n.id === noteId ? { ...n, resolvedAt: resolved ? now : null } : n,
          ),
        })),
      () =>
        api(`/api/notes/${noteId}`, {
          method: "PATCH",
          body: JSON.stringify({ resolved }),
        }),
    );
    loadLogs(taskId);
  }

  // Canvas stickies are Postgres-backed (task_notes with a canvasId), not
  // Liveblocks storage, and low-frequency — they don't go through `mutate`
  // (which reconciles the whole task/project list; unnecessary here). Each
  // one pings peers in the room directly via `emitLocalChange`.
  //
  // They DO bump the reconcile generation, though: `loadCanvasNotes` replaces
  // the list wholesale, and skipping `mutate` used to mean nothing told an
  // in-flight refetch that these optimistic values are newer than its snapshot.
  async function addCanvasNote(
    canvasId: string,
    x: number,
    y: number,
    input: { note: string; type?: NoteType; tags?: string[] },
    taskHandle?: string,
  ) {
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
    reconcileSeq.current++;
    setCanvasNotes((prev) => ({
      ...prev,
      [canvasId]: [
        ...(prev[canvasId] ?? []),
        {
          id: tempId,
          taskId: null,
          canvasId,
          x,
          y,
          note: input.note,
          type: input.type,
          tags: input.tags ?? [],
          author: meName,
          createdAt: now,
        },
      ],
    }));
    try {
      const { note } = await api<{ note: Note }>(`/api/canvases/${canvasId}/notes`, {
        method: "POST",
        body: JSON.stringify({ ...input, x, y, taskHandle }),
      });
      setCanvasNotes((prev) => ({
        ...prev,
        [canvasId]: (prev[canvasId] ?? []).map((n) => (n.id === tempId ? note : n)),
      }));
    } catch (e) {
      console.error("[workspace] add canvas note failed", e);
      setCanvasNotes((prev) => ({
        ...prev,
        [canvasId]: (prev[canvasId] ?? []).filter((n) => n.id !== tempId),
      }));
      setNotice("Couldn’t add that note.");
    }
    emitLocalChange({ kind: "notesRefetch", canvasId });
  }

  async function moveCanvasNote(canvasId: string, noteId: string, x: number, y: number) {
    reconcileSeq.current++;
    setCanvasNotes((prev) => ({
      ...prev,
      [canvasId]: (prev[canvasId] ?? []).map((n) => (n.id === noteId ? { ...n, x, y } : n)),
    }));
    try {
      await api(`/api/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ x, y }) });
    } catch (e) {
      console.error("[workspace] move canvas note failed", e);
    }
    emitLocalChange({ kind: "notesRefetch", canvasId });
  }

  async function resolveCanvasNote(canvasId: string, noteId: string, resolved: boolean) {
    const now = new Date().toISOString();
    reconcileSeq.current++;
    setCanvasNotes((prev) => ({
      ...prev,
      [canvasId]: (prev[canvasId] ?? []).map((n) =>
        n.id === noteId ? { ...n, resolvedAt: resolved ? now : null } : n,
      ),
    }));
    try {
      await api(`/api/notes/${noteId}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved }),
      });
    } catch (e) {
      console.error("[workspace] resolve canvas note failed", e);
    }
    emitLocalChange({ kind: "notesRefetch", canvasId });
  }

  async function deleteCanvasNote(canvasId: string, noteId: string) {
    const prevForCanvas = canvasNotes[canvasId] ?? [];
    reconcileSeq.current++;
    setCanvasNotes((prev) => ({
      ...prev,
      [canvasId]: prevForCanvas.filter((n) => n.id !== noteId),
    }));
    try {
      await api(`/api/notes/${noteId}`, { method: "DELETE" });
    } catch (e) {
      console.error("[workspace] delete canvas note failed", e);
      setCanvasNotes((prev) => ({ ...prev, [canvasId]: prevForCanvas }));
      setNotice("Couldn’t delete that note.");
    }
    emitLocalChange({ kind: "notesRefetch", canvasId });
  }

  async function editWorkflow(
    id: string,
    patch: Partial<Pick<Task, "analysisSummary" | "plan" | "summary">>,
  ) {
    await mutate(
      () =>
        setTaskMap((prev) =>
          prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev,
        ),
      () => api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    );
    loadLogs(id);
  }

  /* ---- Attachments (upload / remove images) ---- */
  // FormData needs a browser-set multipart boundary, so we bypass the
  // JSON `api()` helper and fetch directly (reusing its 401 handling).
  async function addAttachment(id: string, file: File) {
    await mutate(null, async () => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/tasks/${id}/attachments`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        if (res.status === 401 && typeof window !== "undefined")
          window.location.href = "/login";
        throw new Error(`${res.status}: ${await res.text().catch(() => "")}`);
      }
    });
    loadLogs(id); // surface the "attached" activity entry
  }

  // Deleting is optimistic: the server call drops a Blob object and writes a
  // log row before `mutate` refetches, which is seconds of a dead-looking UI if
  // the image only disappears at the end. Drop it from `taskMap` up front — a
  // failure reverts it via the refetch in `mutate` and explains itself there.
  async function removeAttachment(taskId: string, attachmentId: string) {
    await mutate(
      () =>
        setTaskMap((prev) => {
          const t = prev[taskId];
          if (!t?.attachments) return prev;
          return {
            ...prev,
            [taskId]: {
              ...t,
              attachments: t.attachments.filter((a) => a.id !== attachmentId),
            },
          };
        }),
      () =>
        api(`/api/tasks/${taskId}/attachments/${attachmentId}`, {
          method: "DELETE",
        }),
    );
    loadLogs(taskId);
  }

  /* The tree, indexed once per `nodes` change — see `childIndex` on the context
   * type for why. Both helpers below read the indexes, so a caller that was
   * already scanning per call gets the same answers for free. */
  const nodeIndex = useMemo(() => {
    const m = new Map<string, TaskNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);
  const childIndex = useMemo(() => {
    const m = new Map<string | null, TaskNode[]>();
    for (const n of nodes) {
      const siblings = m.get(n.parentId);
      if (siblings) siblings.push(n);
      else m.set(n.parentId, [n]);
    }
    // Sorted here, once, so every lookup is already in display order.
    for (const siblings of m.values()) siblings.sort(compareTaskOrder);
    return m;
  }, [nodes]);

  // Fresh arrays: these are the one-task callers, and handing out the shared
  // index array would let a caller sort or splice it under everyone else.
  const childrenOf = (id: string | null) => [...(childIndex.get(id) ?? [])];
  const nodeById = (id: string) => nodeIndex.get(id);

  return (
    <WorkspaceContext.Provider
      value={{
        nodes,
        taskMap,
        logs,
        notes,
        canvasNotes,
        registerOpenCanvas,
        addCanvasNote,
        moveCanvasNote,
        resolveCanvasNote,
        deleteCanvasNote,
        commits,
        projects,
        openTaskIds,
        openTask,
        closeTask: () => setOpenTaskIds((s) => s.slice(0, -1)),
        closeAllTasks: () => setOpenTaskIds([]),
        addSubtask,
        childrenOf,
        nodeById,
        childIndex,
        nodeIndex,
        registerPlacement,
        start,
        toggleDone,
        setStatus,
        editTask,
        editTaskLive,
        flushEdits,
        toggleSelfAssignee,
        deleteTask,
        undoDelete,
        pendingDeletes,
        moveNode,
        sendToPlacement,
        pendingSend,
        undoSend,
        clearPendingSend,
        moveNodeIntoSection,
        dropToGroup,
        moveToBoard,
        fileTask,
        fileTasks,
        pendingPlacements,
        registerPlacementMap,
        addTask,
        addSectionTask,
        addComment,
        lockTask,
        addNote,
        resolveNote,
        editWorkflow,
        addAttachment,
        removeAttachment,
        createProject,
        renameProject,
        uploadProjectAvatar,
        deleteProject,
        createBoard,
        renameBoard,
        uploadBoardAvatar,
        deleteBoard,
        reorderBoards,
        refresh: async () => {
          await Promise.all([fetchAll(), fetchProjects()]);
          await refreshVersion();
          emitLocalChange();
        },
        bulk,
        archiveAllDone,
        subscribeLocalChange,
        applyRemotePatch,
        refreshFromRemote,
        notice,
        clearNotice: () => setNotice(null),
        pendingComplete,
        completeBranch,
        clearPendingComplete: () => setPendingComplete(null),
        projectSettingsId,
        openProjectSettings: setProjectSettingsId,
        closeProjectSettings: () => setProjectSettingsId(null),
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
