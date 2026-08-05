"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
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
import { deletionOf, type SystemGroup } from "@/lib/sections";
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

/** Which handoff prompt to copy — see `src/lib/prompts.ts`. */
export type PromptKind = "analyze" | "plan" | "work" | "analyze-work";

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
  /** Canvas-only: lend this context your Section resolution so the shared drag
   *  paths can re-pin correctly. Pass null on unmount. */
  registerPlacement: (resolver: PlacementResolver | null) => void;
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
  editTaskLive: (id: string, patch: TaskEdit) => void;
  /** Force-write any pending batched edits now (call on blur / before close). */
  flushEdits: () => Promise<void>;
  /** Toggle the current user in/out of a task's assignees — the canvas SPACE
   *  hover shortcut. No-op when the viewer isn't a known user. */
  toggleSelfAssignee: (id: string) => void;
  /** Delete a task with a ~5s undo window — the canvas DELETE hover shortcut.
   *  See `undoDelete` (cancel) and `pendingDeletes` (the toast). */
  deleteTask: (id: string) => void;
  /** Cancel a pending delete and restore the task; no id ⇒ most recent (LIFO).
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
  /** Send a card to a canvas group: THIS WEEK (end of the list), BACKLOG or
   *  LATER (top), DONE THIS WEEK, or INBOX (unpinned). The hover arrows' path. */
  sendToPlacement: (id: string, to: TaskPlacement) => void;
  moveNodeIntoSection: (
    dragId: string,
    targetPin: string | null,
    targetBoardId: string | null,
    opts?: { targetId?: string; pos?: DropPos; siblingIds?: Set<string> },
  ) => void;
  dropToGroup: (dragId: string, status: TaskStatus) => void;
  /** Move a task onto a board (optionally also set its status). */
  moveToBoard: (id: string, boardId: string, status?: TaskStatus) => void;
  addTask: (status: TaskStatus, title: string, boardId?: string | null) => void;
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
  }) => void;
  /** Post a comment to a task's thread (attributed to "You"). */
  addComment: (id: string, message: string) => Promise<void>;
  /** Lock the task's code (freeze it) and return a ready-to-paste work prompt. */
  lockTask: (id: string) => Promise<string>;
  /** Return a ready-to-paste handoff prompt by kind. Every kind locks the code
   *  first (the analyze handoff is the first commitment). */
  taskPrompt: (id: string, kind: PromptKind) => Promise<string>;
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
  /** Id of the project whose settings modal is open (from anywhere — e.g. the
   *  assignee picker's "Edit Project Members"), or null. */
  projectSettingsId: string | null;
  openProjectSettings: (id: string) => void;
  closeProjectSettings: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const POLL_MS = 2000;
// How long batched text edits sit before being written to Postgres. The canvas
// stays LIVE meanwhile via delta broadcasts; peers apply them without a DB read.
const EDIT_FLUSH_MS = 10000;
// Backstop so a live edit whose author disconnected before flushing doesn't
// linger in the overlay forever (must exceed EDIT_FLUSH_MS).
const OVERLAY_TTL_MS = 30000;
// Grace period between a canvas DELETE and the real Postgres delete — the window
// in which the "Deleted · Undo" toast (or Ctrl+Z) can bring the task back.
const UNDO_WINDOW_MS = 5000;

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
  // cursor against this and only re-fetches the whole list when it moves.
  const lastVersion = useRef<string | null>(null);

  /* ---- Phase 2: batched persistence for high-frequency text edits ---- */
  // `overlay` = unconfirmed field patches (mine + peers', keyed by task) that are
  // re-applied after EVERY refetch, so a delayed DB write or an interim poll can
  // never revert a live edit. Each entry clears once the server value matches it
  // (or after OVERLAY_TTL_MS, a backstop for a sender that died before flushing).
  const overlayRef = useRef<Map<string, { patch: TaskEdit; at: number }>>(new Map());
  // `pendingEdits` = MY edits not yet written to Postgres; flushed on a debounce.
  const pendingEditsRef = useRef<Map<string, TaskEdit>>(new Map());
  const editFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const fetchAll = useCallback(async (): Promise<Record<string, Task> | undefined> => {
    // Snapshot the reconcile generation; if a mutation starts before this fetch
    // resolves, the snapshot may predate that write — skip applying it (a later
    // reconcile / the poll will apply clean state). Still return the fetched map
    // so return-value callers (e.g. `hydrate`) keep working.
    const seq = reconcileSeq.current;
    try {
      const { tasks: fetched } = await api<{ tasks: TaskDTO[] }>("/api/tasks?flat=1");
      // Hide tasks still inside their delete undo window (see `deleteTask`), so
      // an interim poll doesn't flash the card back before the DELETE commits.
      const pend = pendingDeleteRef.current;
      const tasks = pend.size ? fetched.filter((t) => !pend.has(t.id)) : fetched;
      const map = Object.fromEntries(tasks.map((t) => [t.id, t as Task]));
      // A mutation started while this fetch was in flight — its snapshot may
      // predate that write. Don't apply it (nor touch the overlay); return the
      // raw map for callers that only need existence checks. A later reconcile
      // (the mutation's own finally, or the poll) applies clean state.
      if (reconcileSeq.current !== seq) return map;
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
      setTaskMap(map);
      return map;
    } catch (e) {
      console.error("[workspace] failed to load tasks", e);
      return undefined;
    }
  }, []);

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
        // Keep the task map fresh (code/phase/summaries may have changed).
        if (r.task)
          setTaskMap((prev) => ({ ...prev, [id]: { ...prev[id], ...r.task } }));
      })
      .catch((e) => console.error("[workspace] failed to load task detail", e));
  }, []);

  // Load one canvas's stickies (open + resolved). Used when a canvas mounts,
  // and by the poll/remote-refresh loop while `openCanvasIdRef` names one.
  const loadCanvasNotes = useCallback((canvasId: string) => {
    api<{ notes: Note[] }>(`/api/canvases/${canvasId}/notes`)
      .then((r) => setCanvasNotes((prev) => ({ ...prev, [canvasId]: r.notes })))
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
    const iv = setInterval(async () => {
      if (inflight.current !== 0 || document.hidden) return;
      try {
        const { v } = await api<{ v: string }>("/api/version");
        if (v !== lastVersion.current) {
          lastVersion.current = v;
          await Promise.all([fetchAll(), fetchProjects()]);
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
    }, POLL_MS);
    const onFocus = () => {
      if (inflight.current === 0) reload();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchAll, fetchProjects, refreshVersion, loadLogs, loadCanvasNotes]);

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
        // writer won); everything else gets the generic one.
        setNotice(
          e instanceof ApiError && e.status === 409
            ? "This task changed elsewhere — reloaded with the latest version."
            : "Couldn’t save that — reloaded the latest.",
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
    return api(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      ...(guarded ? { headers: { "X-Expected-Updated-At": token } } : {}),
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
   * Finished work exits in TWO steps (`deletionOf`): the first Delete on a done
   * card PARKS it in DONE THIS WEEK, and only a second Delete from there archives
   * it. So the week's finished work stays visible until it's swept, and the
   * irreversible-looking step always takes a deliberate second press. A card that
   * was never done still deletes on the first press — parking it would put a
   * not-done card in a group called DONE THIS WEEK.
   *
   * Parking needs a canvas: the lanes live in its Liveblocks storage. On the
   * board views (no `placementRef`) there's nowhere to park, so a done card
   * archives on the first press exactly as it always has.
   */
  function deleteTask(id: string) {
    const task = taskMapRef.current[id];
    if (!task || pendingDeleteRef.current.has(id)) return;
    const placement = placementRef.current;
    const action = placement
      ? deletionOf(task.status, placement.groupOf(id))
      : task.status === "done"
        ? "archive"
        : "delete";
    if (action === "park" && placement) {
      const boardId = task.boardId ?? null;
      const lane = placement.laneFor("doneThisWeek", boardId);
      // No lane resolvable (shouldn't happen — the reconciler keeps the group
      // alive — but a canvas mid-hydration could say null). Archive instead of
      // silently doing nothing.
      if (lane) {
        moveNodeIntoSection(id, lane, boardId, {
          siblingIds: placement.membersOf(lane),
        });
        return;
      }
    }
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

  /** Cancel a pending delete and restore the task. With no id, undoes the most
   *  recent (LIFO) — the canvas Ctrl+Z path. Returns whether it undid anything. */
  const undoDelete = useCallback((id?: string): boolean => {
    const pend = pendingDeleteRef.current;
    const target = id ?? [...pend.keys()].pop();
    if (!target) return false;
    const entry = pend.get(target);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pend.delete(target);
    setPendingDeletes((s) => s.filter((d) => d.id !== target));
    setTaskMap((prev) => ({ ...prev, [target]: entry.task }));
    if (entry.node) {
      const restored = entry.node;
      setNodes((prev) => (prev.some((x) => x.id === target) ? prev : [...prev, restored]));
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
      await Promise.all(edits.map(([id, patch]) => patchTask(id, patch)));
    } catch (e) {
      console.error("[workspace] edit flush failed", e);
      setNotice(
        e instanceof ApiError && e.status === 409
          ? "This task changed elsewhere — reloaded with the latest version."
          : "Couldn’t save your edit — reloaded the latest.",
      );
    } finally {
      inflight.current--;
      await fetchAll(); // overlay reconciles: confirmed patches drop out
      await refreshVersion();
      emitLocalChange(); // peers refetch the now-persisted state
    }
    // patchTask is a stable hoisted declaration reading refs — no dep needed.
  }, [fetchAll, refreshVersion, emitLocalChange]);

  const scheduleEditFlush = useCallback(() => {
    if (editFlushTimer.current) clearTimeout(editFlushTimer.current);
    editFlushTimer.current = setTimeout(() => void flushEdits(), EDIT_FLUSH_MS);
  }, [flushEdits]);

  /** Live edit for high-frequency text (title/description): apply optimistically,
   *  broadcast the delta so peers update instantly, and DEFER the Postgres write
   *  (batched ~10s / flushed on blur/close). Contrast `editTask`, which persists
   *  immediately — use this only for fields that change on every keystroke. */
  function editTaskLive(id: string, patch: TaskEdit) {
    overlayRef.current.set(id, {
      patch: { ...(overlayRef.current.get(id)?.patch ?? {}), ...patch },
      at: Date.now(),
    });
    setTaskMap((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
    emitLocalChange({ kind: "patch", taskId: id, patch });
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
   * No-op without a mounted canvas, or when the card is already there — the
   * groups are canvas furniture, so there's nothing to move it to (or nothing to
   * do) in either case.
   */
  function sendToPlacement(id: string, to: TaskPlacement) {
    const placement = placementRef.current;
    const task = taskMap[id];
    if (!placement || !task) return;
    const boardId = task.boardId ?? null;
    const lane = placement.laneFor(to, boardId);
    if (to !== "inbox" && !lane) return; // no such group on this canvas
    if (placement.sectionOf(id) === lane) return;
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
  }

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
    opts?: { targetId?: string; pos?: DropPos; siblingIds?: Set<string> },
  ) {
    const rel =
      opts?.targetId && opts.pos ? { targetId: opts.targetId, pos: opts.pos } : undefined;
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

    // No-op guard: same pin, same spot, same board.
    const dragPin = taskMap[dragId]?.canvasSectionId ?? null;
    if (!boardChanged && dragPin === targetPin && drag.parentId === parentId && drag.position === position)
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
  function addTask(status: TaskStatus, title: string, boardId: string | null = null) {
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
          [tempId]: { id: tempId, title, status, assigneeIds: [], boardId, updatedAt: now },
        }));
        setNodes((prev) => [
          ...prev,
          { id: tempId, parentId: null, boardId, status, statusSince: now, position: maxPos + 1, createdAt: now },
        ]);
      },
      () =>
        api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ title, status, assigneeIds: [], boardId }),
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
  }) {
    const { title, canvasSectionId, boardId, siblingIds } = input;
    const parentId = input.parentId ?? null;
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
    // End of this section's sibling group (same parent), not the global status
    // group — the section list sorts by position within a parent regardless of
    // status.
    const maxPos = Math.max(
      0,
      ...nodes
        .filter(
          (n) =>
            n.parentId === parentId &&
            (siblingIds
              ? siblingIds.has(n.id)
              : (taskMap[n.id]?.canvasSectionId ?? null) === canvasSectionId),
        )
        .map((n) => n.position),
    );
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
          ...prev,
          { id: tempId, parentId, boardId, status: "backlog", statusSince: now, position: maxPos + 1, createdAt: now },
        ]);
      },
      () =>
        api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            title,
            status: "backlog",
            assigneeIds: [],
            boardId,
            parentId,
            canvasSectionId,
          }),
        }),
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

  // Lock the code (freeze it) and return the ready-to-paste work prompt. The
  // server is idempotent, so a second click just re-returns the same prompt.
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

  // Return a handoff prompt by kind. "work"/"analyze-work" lock the code
  // server-side, so merge the returned task back (its code may have hardened).
  async function taskPrompt(id: string, kind: PromptKind): Promise<string> {
    const res = await api<{ task: Task; prompt: string }>(
      `/api/tasks/${id}/prompt`,
      { method: "POST", body: JSON.stringify({ kind }) },
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
  async function addCanvasNote(
    canvasId: string,
    x: number,
    y: number,
    input: { note: string; type?: NoteType; tags?: string[] },
    taskHandle?: string,
  ) {
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
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

  async function removeAttachment(taskId: string, attachmentId: string) {
    await mutate(null, () =>
      api(`/api/tasks/${taskId}/attachments/${attachmentId}`, {
        method: "DELETE",
      }),
    );
    loadLogs(taskId);
  }

  const childrenOf = (id: string | null) =>
    nodes.filter((n) => n.parentId === id).sort(compareTaskOrder);
  const nodeById = (id: string) => nodes.find((n) => n.id === id);

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
        moveNodeIntoSection,
        dropToGroup,
        moveToBoard,
        addTask,
        addSectionTask,
        addComment,
        lockTask,
        taskPrompt,
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
