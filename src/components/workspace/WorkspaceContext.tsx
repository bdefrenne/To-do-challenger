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
  Decision,
  DecisionCategory,
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
  decisions: Record<string, Decision[]>;
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
   *  writes via If-Match — a conflict surfaces `notice` and reloads. */
  editTask: (id: string, patch: TaskEdit) => void;
  moveNode: (dragId: string, targetId: string, pos: DropPos) => void;
  dropToGroup: (dragId: string, status: TaskStatus) => void;
  /** Move a task onto a board (optionally also set its status). */
  moveToBoard: (id: string, boardId: string, status?: TaskStatus) => void;
  addTask: (status: TaskStatus, title: string, boardId?: string | null) => void;
  /** Post a comment to a task's thread (attributed to "You"). */
  addComment: (id: string, message: string) => Promise<void>;
  /** Lock the task's code (freeze it) and return a ready-to-paste work prompt. */
  lockTask: (id: string) => Promise<string>;
  /** Enter the analysis phase (stamps analysisStartedAt + logs it) and return a
   *  ready-to-paste "analyze this" prompt. */
  startAnalysis: (id: string) => Promise<string>;
  /** Enter the work phase (stamps workStartedAt + logs it) and return a
   *  ready-to-paste "build this" prompt. */
  startWork: (id: string) => Promise<string>;
  /** Record a decision on a task, then reload its detail. */
  recordDecision: (
    id: string,
    input: { category: DecisionCategory; decision: string; rationale?: string },
  ) => Promise<void>;
  /** Add a standup note to a task, then reload its detail. */
  addNote: (id: string, input: { note: string; type?: NoteType }) => Promise<void>;
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
  }) => Promise<Project | null>;
  /** Edit a project's name / shortname / color / picture / git folder / readme.
   *  `image`/`gitFolder`/`description` accept null to clear. */
  renameProject: (
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
  /** Transient user-facing message (e.g. a concurrent-edit conflict). */
  notice: string | null;
  clearNotice: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const POLL_MS = 2000;

/** A partial task edit the client can PATCH. */
export type TaskEdit = Partial<
  Pick<
    Task,
    | "title"
    | "status"
    | "assignees"
    | "startDate"
    | "dueDate"
    | "recurrence"
    | "dependsOn"
    | "customFields"
    | "value"
    | "difficulty"
    | "tags"
    | "description"
  >
>;

/** Human-authored content fields. An edit touching any of these opts into the
 *  If-Match optimistic-concurrency check; positional/status-only writes don't
 *  (they're last-write-wins and self-heal on the next refetch). */
const CONTENT_FIELDS: (keyof TaskEdit)[] = [
  "title",
  "description",
  "tags",
  "assignees",
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
  /** Display name of the signed-in user — new tasks are assigned to them. */
  meName = "You",
}: {
  children: ReactNode;
  meName?: string;
}) {
  const [nodes, setNodes] = useState<TaskNode[]>([]);
  const [taskMap, setTaskMap] = useState<Record<string, Task>>({});
  const [logs, setLogs] = useState<Record<string, TaskLogEntry[]>>({});
  const [decisions, setDecisions] = useState<Record<string, Decision[]>>({});
  const [notes, setNotes] = useState<Record<string, Note[]>>({});
  const [commits, setCommits] = useState<Record<string, TaskCommit[]>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  // Stack of open task-detail modals (bottom → top). Empty = nothing open.
  const [openTaskIds, setOpenTaskIds] = useState<string[]>([]);
  // Transient, user-facing message (e.g. a write was rejected as a conflict).
  const [notice, setNotice] = useState<string | null>(null);

  // Pause polling while a local mutation is in flight, so a background
  // refetch can't clobber an optimistic update mid-op.
  const inflight = useRef(0);

  // Last change-cursor we've reconciled to. The poll compares the server's
  // cursor against this and only re-fetches the whole list when it moves.
  const lastVersion = useRef<string | null>(null);

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
    try {
      const { tasks } = await api<{ tasks: TaskDTO[] }>("/api/tasks?flat=1");
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
      const map = Object.fromEntries(tasks.map((t) => [t.id, t as Task]));
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
      decisions?: Decision[];
      notes?: Note[];
      commits?: TaskCommit[];
    }>(`/api/tasks/${id}`)
      .then((r) => {
        setLogs((prev) => ({ ...prev, [id]: r.logs }));
        setDecisions((prev) => ({ ...prev, [id]: r.decisions ?? [] }));
        setNotes((prev) => ({ ...prev, [id]: r.notes ?? [] }));
        setCommits((prev) => ({ ...prev, [id]: r.commits ?? [] }));
        // Keep the task map fresh (code/phase/summaries may have changed).
        if (r.task)
          setTaskMap((prev) => ({ ...prev, [id]: { ...prev[id], ...r.task } }));
      })
      .catch((e) => console.error("[workspace] failed to load task detail", e));
  }, []);

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

  /** Optimistic update now, server call, then reconcile from the source. */
  const mutate = useCallback(
    async (optimistic: (() => void) | null, serverCall: () => Promise<unknown>) => {
      inflight.current++;
      optimistic?.();
      try {
        await serverCall();
      } catch (e) {
        console.error("[workspace] mutation failed", e);
        // Optimistic-concurrency conflict: another writer changed the task
        // first. The finally-refetch below pulls their version; tell the user.
        if (e instanceof ApiError && e.status === 409)
          setNotice("This task changed elsewhere — reloaded with the latest version.");
      } finally {
        inflight.current--;
        await fetchAll();
        // Our own write moved the cursor; sync it so the next poll tick
        // doesn't see a "change" and re-fetch redundantly.
        await refreshVersion();
      }
    },
    [fetchAll, refreshVersion],
  );

  /** Like `mutate`, but for project/board changes — reconciles the sidebar. */
  const mutateProjects = useCallback(
    async (serverCall: () => Promise<unknown>) => {
      inflight.current++;
      try {
        await serverCall();
      } catch (e) {
        console.error("[workspace] project mutation failed", e);
      } finally {
        inflight.current--;
        await Promise.all([fetchProjects(), fetchAll()]);
        await refreshVersion();
      }
    },
    [fetchProjects, fetchAll, refreshVersion],
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
    const token = taskMap[id]?.updatedAt;
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

  function start(id: string) {
    if (nodes.find((n) => n.id === id)?.status === "in-progress") return;
    mutate(
      () => patchStatusLocal(id, "in-progress"),
      () => patchTask(id, { status: "in-progress" }),
    );
  }

  function toggleDone(id: string) {
    const nowDone = nodes.find((n) => n.id === id)?.status !== "done";
    mutate(
      () => patchStatusLocal(id, nowDone ? "done" : "planned"),
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
          [tempId]: { id: tempId, title, status, assignees: [meName], boardId, updatedAt: now },
        }));
        setNodes((prev) => [
          ...prev,
          { id: tempId, parentId: null, boardId, status, statusSince: now, position: maxPos + 1 },
        ]);
      },
      () =>
        api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ title, status, assignees: [meName], boardId }),
        }),
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
        assignees: [meName],
        boardId: taskMap[parentId]?.boardId ?? null,
        parentId,
      }),
    });
    await fetchAll();
    await refreshVersion();
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

  /* ---- Workflow: lock / decisions / notes / summaries ---- */

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

  // Enter a phase (analysis or work): the server stamps the start timestamp,
  // logs an attributed `started` entry, and returns the phase prompt. Both are
  // idempotent, so a second click just re-returns the prompt.
  async function enterPhase(id: string, phase: "analysis" | "work") {
    const res = await api<{ task: Task; prompt: string }>(
      `/api/tasks/${id}/start-${phase === "analysis" ? "analysis" : "work"}`,
      { method: "POST" },
    );
    setTaskMap((prev) =>
      prev[id] ? { ...prev, [id]: { ...prev[id], ...res.task } } : prev,
    );
    return res.prompt;
  }
  const startAnalysis = (id: string) => enterPhase(id, "analysis");
  const startWork = (id: string) => enterPhase(id, "work");

  // Optimistically append a temp row (rendered with a small "saving" spinner),
  // POST it, then reload so the temp entry is replaced by the server row.
  async function recordDecision(
    id: string,
    input: { category: DecisionCategory; decision: string; rationale?: string },
  ) {
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
    await mutate(
      () =>
        setDecisions((prev) => ({
          ...prev,
          [id]: [
            ...(prev[id] ?? []),
            {
              id: tempId,
              taskId: id,
              category: input.category,
              decision: input.decision,
              rationale: input.rationale,
              phase: "execution",
              author: meName,
              createdAt: now,
            },
          ],
        })),
      () =>
        api(`/api/tasks/${id}/decisions`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
    );
    loadLogs(id);
  }

  async function addNote(id: string, input: { note: string; type?: NoteType }) {
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
        decisions,
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
        moveNode,
        dropToGroup,
        moveToBoard,
        addTask,
        addComment,
        lockTask,
        startAnalysis,
        startWork,
        recordDecision,
        addNote,
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
        notice,
        clearNotice: () => setNotice(null),
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
