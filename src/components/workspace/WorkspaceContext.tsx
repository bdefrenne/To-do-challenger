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
  TaskLogEntry,
  Project,
  Board,
  Note,
  NoteType,
  TaskCommit,
} from "@/lib/types";

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
export interface TaskNode {
  id: string;
  parentId: string | null;
  boardId: string | null;
  status: TaskStatus;
  statusSince: string; // ISO — when it entered the current status
  position: number;
}

interface WorkspaceContextValue {
  nodes: TaskNode[];
  taskMap: Record<string, Task>;
  logs: Record<string, TaskLogEntry[]>;
  /** Per-task workflow detail, loaded alongside the activity log. */
  notes: Record<string, Note[]>;
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
  start: (id: string) => void;
  toggleDone: (id: string) => void;
  setStatus: (id: string, status: TaskStatus) => void;
  /** Edit content fields (title/description/…); guarded against concurrent
   *  writes via If-Match — a conflict surfaces `notice` and reloads. Persists
   *  immediately; use for discrete edits (assignees, dates, one-shot title). */
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
  /** Tasks inside their delete undo window (oldest → newest), for the toast. */
  pendingDeletes: { id: string; title: string }[];
  moveNode: (dragId: string, targetId: string, pos: DropPos) => void;
  dropToGroup: (dragId: string, status: TaskStatus) => void;
  /** Move a task onto a board (optionally also set its status). */
  moveToBoard: (id: string, boardId: string, status?: TaskStatus) => void;
  addTask: (status: TaskStatus, title: string, boardId?: string | null) => void;
  /** Create a task inside a canvas Section (tagged by `customFields.sectionId`),
   *  optionally nested under `parentId`. Optimistic, like `addTask`. */
  addSectionTask: (input: {
    title: string;
    sectionId: string;
    boardId: string | null;
    parentId?: string | null;
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
 *  their taskMap (so the view is live even though the DB write is deferred). */
export type ChangeSignal =
  | { kind: "refetch" }
  | { kind: "patch"; taskId: string; patch: TaskEdit };

/** Human-authored content fields. An edit touching any of these opts into the
 *  If-Match optimistic-concurrency check; positional/status-only writes don't
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
  // Latest taskMap for the (possibly delayed) flush's If-Match token.
  const taskMapRef = useRef<Record<string, Task>>({});
  useEffect(() => void (taskMapRef.current = taskMap), [taskMap]);

  // Latest nodes list, so a delete can snapshot the removed node for undo.
  const nodesRef = useRef<TaskNode[]>([]);
  useEffect(() => void (nodesRef.current = nodes), [nodes]);

  // Tasks removed on the canvas but not yet committed to Postgres — kept alive
  // for the ~5s undo window (Gmail-style). `fetchAll` filters these ids so a
  // background poll can't resurrect the card; each timer fires the real DELETE
  // when its window lapses. `pendingDeletes` mirrors it for the toast.
  const pendingDeleteRef = useRef<
    Map<string, { task: Task; node: TaskNode | undefined; timer: ReturnType<typeof setTimeout> }>
  >(new Map());
  const [pendingDeletes, setPendingDeletes] = useState<{ id: string; title: string }[]>([]);

  // Mirror of the open-modal stack so the (never re-armed) poll closure can
  // refresh every open task's thread when the cursor moves — no interval re-arm.
  const openTaskIdsRef = useRef<string[]>([]);
  useEffect(() => {
    openTaskIdsRef.current = openTaskIds;
  }, [openTaskIds]);

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
          return refreshVersion();
        })
        .catch((e) => console.error("[workspace] remote refresh failed", e));
    }, 150);
  }, [fetchAll, fetchProjects, refreshVersion, loadLogs]);

  // Initial load, then poll a tiny change-cursor (not the whole list) and
  // only re-fetch when it moves. Plus revalidate-on-focus.
  useEffect(() => {
    // The cursor folds in projects + boards, so refresh both, then resync
    // the cursor so our own reload doesn't look like a change next tick.
    const reload = () =>
      Promise.all([fetchAll(), fetchProjects()]).then(() => {
        openTaskIdsRef.current.forEach((id) => loadLogs(id));
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
  }, [fetchAll, fetchProjects, refreshVersion, loadLogs]);

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
        // Optimistic-concurrency conflict: another writer changed the task
        // first. The finally-refetch below pulls their version; tell the user.
        if (e instanceof ApiError && e.status === 409)
          setNotice("This task changed elsewhere — reloaded with the latest version.");
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

  /** Like `mutate`, but for project/board changes — reconciles the sidebar. */
  const mutateProjects = useCallback(
    async (serverCall: () => Promise<unknown>) => {
      inflight.current++;
      reconcileSeq.current++;
      try {
        await serverCall();
      } catch (e) {
        console.error("[workspace] project mutation failed", e);
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
   * …) and we know the task's current `updatedAt`, send it as `If-Match` so
   * the server rejects the write with a 409 if another writer changed the
   * task first. Status-only patches send no header → last-write-wins.
   */
  function patchTask(id: string, patch: TaskEdit) {
    // Read the token from the ref, not the render's taskMap — a batched flush can
    // fire seconds later and must send the LATEST updatedAt to avoid a false 409.
    const token = taskMapRef.current[id]?.updatedAt;
    const guarded = token && CONTENT_FIELDS.some((f) => f in patch);
    return api(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      ...(guarded ? { headers: { "If-Match": token } } : {}),
    });
  }

  /** Edit content fields on a task (guarded by If-Match via `patchTask`). */
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
      mutate(null, () => api(`/api/tasks/${id}`, { method: "DELETE" }));
    },
    [mutate],
  );

  /** Delete a task with an undo window: drop it from view immediately, then
   *  commit the DELETE to Postgres after UNDO_WINDOW_MS unless `undoDelete`
   *  cancels first. The removed node is snapshotted so undo can restore it. */
  function deleteTask(id: string) {
    const task = taskMapRef.current[id];
    if (!task || pendingDeleteRef.current.has(id)) return;
    const node = nodesRef.current.find((n) => n.id === id);
    setTaskMap((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setNodes((prev) => prev.filter((n) => n.id !== id));
    const timer = setTimeout(() => commitDelete(id), UNDO_WINDOW_MS);
    pendingDeleteRef.current.set(id, { task, node, timer });
    setPendingDeletes((s) => [...s.filter((d) => d.id !== id), { id, title: task.title }]);
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
      for (const [id, { timer }] of pendingDeleteRef.current) {
        clearTimeout(timer);
        void api(`/api/tasks/${id}`, { method: "DELETE" }).catch(() => {});
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
      if (e instanceof ApiError && e.status === 409)
        setNotice("This task changed elsewhere — reloaded with the latest version.");
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

  /* ---- Drag & drop: reorder / nest / cross-group ---- */
  function moveNode(dragId: string, targetId: string, pos: DropPos) {
    if (dragId === targetId) return;
    if (isDescendant(nodes, dragId, targetId)) return;
    const drag = nodes.find((n) => n.id === dragId);
    const target = nodes.find((n) => n.id === targetId);
    if (!drag || !target) return;

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

    // before/after: same parent as target, adopt its status, fractional pos.
    const status = target.status;
    const siblings = nodes
      .filter((n) => n.id !== dragId && n.parentId === target.parentId && n.status === status)
      .sort((a, b) => a.position - b.position);
    const ti = siblings.findIndex((s) => s.id === targetId);
    let position: number;
    if (pos === "before") {
      const prev = siblings[ti - 1];
      position = prev ? (prev.position + target.position) / 2 : target.position - 1;
    } else {
      const next = siblings[ti + 1];
      position = next ? (target.position + next.position) / 2 : target.position + 1;
    }

    mutate(
      () =>
        setNodes((prev) =>
          prev.map((n) =>
            n.id === dragId
              ? { ...n, parentId: target.parentId, status, position }
              : n,
          ),
        ),
      () =>
        api(`/api/tasks/${dragId}/move`, {
          method: "POST",
          body: JSON.stringify({ parentId: target.parentId, status, position }),
        }),
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
      () =>
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
        ),
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
          [tempId]: { id: tempId, title, status, assigneeIds: meId ? [meId] : [], boardId, updatedAt: now },
        }));
        setNodes((prev) => [
          ...prev,
          { id: tempId, parentId: null, boardId, status, statusSince: now, position: maxPos + 1 },
        ]);
      },
      () =>
        api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ title, status, assigneeIds: meId ? [meId] : [], boardId }),
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

  // Create a task inside a canvas Section. A section's tasks are scoped by the
  // hidden `customFields.sectionId` tag (not by board), so that tag — and the
  // section's boardId — MUST ride along or the card won't show. Mirrors addTask's
  // optimistic temp-id → real-id swap; `parentId` set makes it a subtask.
  function addSectionTask(input: {
    title: string;
    sectionId: string;
    boardId: string | null;
    parentId?: string | null;
  }) {
    const { title, sectionId, boardId } = input;
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
            taskMap[n.id]?.customFields?.sectionId === sectionId,
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
            assigneeIds: meId ? [meId] : [],
            boardId,
            customFields: { sectionId },
            updatedAt: now,
          },
        }));
        setNodes((prev) => [
          ...prev,
          { id: tempId, parentId, boardId, status: "backlog", statusSince: now, position: maxPos + 1 },
        ]);
      },
      () =>
        api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            title,
            status: "backlog",
            assigneeIds: meId ? [meId] : [],
            boardId,
            parentId,
            customFields: { sectionId },
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
        assigneeIds: meId ? [meId] : [],
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
    nodes.filter((n) => n.parentId === id).sort((a, b) => a.position - b.position);
  const nodeById = (id: string) => nodes.find((n) => n.id === id);

  return (
    <WorkspaceContext.Provider
      value={{
        nodes,
        taskMap,
        logs,
        notes,
        commits,
        projects,
        openTaskIds,
        openTask,
        closeTask: () => setOpenTaskIds((s) => s.slice(0, -1)),
        closeAllTasks: () => setOpenTaskIds([]),
        addSubtask,
        childrenOf,
        nodeById,
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
