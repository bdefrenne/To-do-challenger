"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { WorkspaceProvider, useWorkspace } from "./workspace/WorkspaceContext";
import { TaskDetailModal } from "./workspace/TaskDetailModal";
import { ShortcutsHelp, openShortcutsHelp } from "./workspace/ShortcutsHelp";
import { BoardModal } from "./workspace/BoardModal";
import { ProjectModal } from "./workspace/ProjectModal";
import { PeopleProvider, usePeople } from "./PeopleContext";
import { Avatar } from "./ui/Badge";
import type { Project, TaskPlacement } from "@/lib/types";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** Avatar ring/stroke color (hex). */
  color: string;
  /** Profile picture URL, or null (initials fallback). */
  avatarUrl: string | null;
  /** Working language ("en" | "fr"). */
  language: "en" | "fr";
}

const NAV = [
  { href: "/", label: "All tasks", icon: "☰" },
  { href: "/today", label: "Today", icon: "◎" },
  { href: "/day", label: "Finish work", icon: "◑" },
  { href: "/canvas", label: "Canvas", icon: "◳" },
  { href: "/notes", label: "Notes", icon: "✎" },
  { href: "/calendar", label: "Calendar", icon: "▦" },
  { href: "/archived", label: "Archived", icon: "🗄" },
];

const SIDEBAR_KEY = "sidebar:open";

/** The sidebar's open/closed flag, kept in localStorage so the choice survives
 *  reloads (and stays in step across tabs). Read through
 *  `useSyncExternalStore` so SSR always renders it closed — the default — and
 *  the stored value is picked up right after hydration. */
const sidebarListeners = new Set<() => void>();

function subscribeSidebar(onChange: () => void) {
  sidebarListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    sidebarListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readSidebarOpen() {
  return localStorage.getItem(SIDEBAR_KEY) === "1";
}

function writeSidebarOpen(open: boolean) {
  localStorage.setItem(SIDEBAR_KEY, open ? "1" : "0");
  for (const cb of sidebarListeners) cb();
}

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: SessionUser;
}) {
  const sidebarOpen = useSyncExternalStore(
    subscribeSidebar,
    readSidebarOpen,
    () => false,
  );
  const toggleSidebar = () => writeSidebarOpen(!sidebarOpen);

  return (
    <PeopleProvider me={user}>
      <WorkspaceProvider meName={user.name} meId={user.id}>
        <div className="flex min-h-screen">
          {sidebarOpen ? (
            <Sidebar user={user} onClose={toggleSidebar} />
          ) : (
            <SidebarRail onOpen={toggleSidebar} />
          )}
          {/* `overflow-x-clip`, NOT `-hidden`: `hidden` makes this a scroll
              container (and per spec promotes overflow-y to `auto`). Nothing
              here should ever scroll — the one wide surface, TaskTable, brings
              its own `overflow-x-auto` — but a focusable element out in a
              clipped subtree (the canvas is full of them) makes the browser
              scroll THIS box to reveal it, and Chrome then restores that offset
              across reloads, leaving the canvas translated off-screen with no
              way to recover. `clip` clips identically and is unscrollable, so
              the offset can't exist. See TD-133. */}
          <main className="min-w-0 flex-1 overflow-x-clip">{children}</main>
        </div>
        <TaskDetailModal />
        <GlobalProjectSettings />
        <ShortcutsHelp />
        <Notice />
        <DeleteUndoToast />
        <SendUndoToast />
        <CompleteBranchPrompt />
      </WorkspaceProvider>
    </PeopleProvider>
  );
}

/** The single project-settings modal opened from anywhere via the workspace's
 *  `openProjectSettings(id)` — e.g. the assignee picker's "Edit Project
 *  Members" button. Distinct from the sidebar gear's own local modal. */
function GlobalProjectSettings() {
  const { projects, projectSettingsId, closeProjectSettings } = useWorkspace();
  if (!projectSettingsId) return null;
  const project = projects.find((p) => p.id === projectSettingsId);
  if (!project) return null;
  return (
    <ProjectModal mode="edit" project={project} onClose={closeProjectSettings} />
  );
}

/** Transient toast for workspace notices (e.g. a concurrent-edit conflict).
 *  Auto-dismisses after a few seconds; click to dismiss sooner. */
function Notice() {
  const { notice, clearNotice } = useWorkspace();
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearNotice, 4000);
    return () => clearTimeout(t);
  }, [notice, clearNotice]);

  if (!notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[300] flex justify-center px-4">
      <button
        onClick={clearNotice}
        role="status"
        className="pointer-events-auto max-w-md rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-fg shadow-lg transition-colors hover:bg-surface-2"
      >
        {notice}
      </button>
    </div>
  );
}

/** "Deleted · Undo" toast for canvas task deletes still inside their undo
 *  window. Clears itself when the window lapses (delete commits) or on Undo.
 *  Undo takes back EVERY task in the window, not just the newest — see
 *  `undoDelete`; the toast counts them so it's clear how many come back. */
function DeleteUndoToast() {
  const { pendingDeletes, undoDelete } = useWorkspace();
  if (!pendingDeletes.length) return null;
  const last = pendingDeletes[pendingDeletes.length - 1];
  // Done tasks are archived, not deleted; a run of presses can be a mix of both,
  // and then neither verb is true of all of them.
  const mixed = pendingDeletes.some((d) => d.mode !== last.mode);
  const verb = mixed ? "Removed" : last.mode === "archive" ? "Archived" : "Deleted";
  const label =
    pendingDeletes.length > 1
      ? `${verb} ${pendingDeletes.length} tasks`
      : `${verb} “${last.title}”`;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[300] flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-fg shadow-lg"
      >
        <span className="max-w-[16rem] truncate">{label}</span>
        <button
          onClick={() => undoDelete()}
          className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:border-accent"
        >
          Undo
          <kbd className="rounded bg-surface-3 px-1 text-[9px] font-semibold leading-none text-faint">
            ⌘Z
          </kbd>
        </button>
      </div>
    </div>
  );
}

const SEND_LABEL: Record<TaskPlacement, string> = {
  inbox: "Inbox",
  today: "Today",
  thisWeek: "This week",
  backlog: "Backlog",
  later: "Later",
  doneThisWeek: "Done this week",
};

/** "Sent … · Undo" toast for the canvas hover arrows (↑/→/↓ → THIS WEEK /
 *  BACKLOG / LATER). A send commits immediately, so unlike `DeleteUndoToast`
 *  there's no grace window to show — this just fires on every send, no
 *  debounce, overwriting whatever it was already showing. */
function SendUndoToast() {
  const { pendingSend, undoSend, clearPendingSend } = useWorkspace();
  useEffect(() => {
    if (!pendingSend) return;
    const t = setTimeout(clearPendingSend, 4000);
    return () => clearTimeout(t);
  }, [pendingSend, clearPendingSend]);

  if (!pendingSend) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-32 z-[300] flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-fg shadow-lg"
      >
        <span className="max-w-[16rem] truncate">
          Sent “{pendingSend.title}” to {SEND_LABEL[pendingSend.to]}
        </span>
        <button
          onClick={undoSend}
          className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:border-accent"
        >
          Undo
        </button>
      </div>
    </div>
  );
}

/**
 * The answer to a refused completion: this task still has unfinished subtasks.
 *
 * A question, not a notice — so unlike the toasts above it does NOT auto-dismiss,
 * and it offers the only path that closes a branch in one action
 * (`completeBranch` → `withSubtasks`). Without it the rule is a dead end: DELETE
 * on a Review card means "complete", so a parent with open children could be
 * refused with nothing to do about it but hunt down each child.
 *
 * "Not now" leaves everything exactly as it was — the refused write never landed.
 */
function CompleteBranchPrompt() {
  const { pendingComplete, completeBranch, clearPendingComplete } = useWorkspace();
  if (!pendingComplete) return null;
  const { taskId, taskTitle, openCount } = pendingComplete;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-32 z-[300] flex justify-center px-4">
      <div
        role="alertdialog"
        aria-label="Unfinished subtasks"
        className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-fg shadow-lg"
      >
        <span className="min-w-0">
          <span className="max-w-[18rem] truncate font-medium">{taskTitle}</span>{" "}
          <span className="text-muted">
            still has {openCount} unfinished subtask{openCount === 1 ? "" : "s"}.
          </span>
        </span>
        <button
          onClick={() => completeBranch(taskId)}
          className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:border-accent"
        >
          Complete all {openCount}
        </button>
        <button
          onClick={clearPendingComplete}
          className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-faint transition-colors hover:text-fg"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/** Collapsed stand-in for the sidebar: a narrow gutter holding just the button
 *  that brings it back, so page content never sits under the toggle. */
function SidebarRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="sticky top-0 flex h-screen w-11 shrink-0 flex-col items-center py-4">
      <button
        onClick={onOpen}
        title="Show sidebar"
        aria-label="Show sidebar"
        aria-expanded={false}
        className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-fg"
      >
        »
      </button>
    </div>
  );
}

function Sidebar({ user, onClose }: { user: SessionUser; onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  // Prefer the live roster entry so a just-saved picture/color shows without a
  // full reload; fall back to the server-rendered session user.
  const { me } = usePeople();
  const identity = me ?? user;
  return (
    <aside className="sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-white">
          ✓
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-semibold tracking-tight">
            To-do Challenger
          </div>
          <div className="text-[11px] text-faint">Personal workspace</div>
        </div>
        <button
          onClick={onClose}
          title="Hide sidebar"
          aria-label="Hide sidebar"
          aria-expanded
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-fg"
        >
          «
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 px-3 py-2">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={[
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-muted hover:bg-surface-2 hover:text-fg",
              ].join(" ")}
            >
              <span
                className={`text-base ${active ? "text-accent" : "text-faint"}`}
              >
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <ProjectsNav />

      <div ref={menuRef} className="relative mt-auto border-t border-border p-2">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2"
        >
          <Avatar
            name={identity.name || identity.email}
            size={32}
            imageUrl={identity.avatarUrl}
            color={identity.color}
          />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-fg">{identity.name}</div>
            <div className="truncate text-[11px] text-faint">{identity.email}</div>
          </div>
          <span className="text-faint">▾</span>
        </button>

        {menuOpen ? (
          <div
            role="menu"
            className="absolute bottom-full left-2 right-2 mb-1 z-40 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
          >
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                openShortcutsHelp();
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-surface-2"
            >
              <span className="flex items-center gap-2">
                <span className="text-faint">⌨</span>
                Keyboard shortcuts
              </span>
              <kbd className="rounded bg-surface-3 px-1 text-[10px] font-semibold leading-none text-faint">
                ?
              </kbd>
            </button>
            <Link
              href="/settings"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-surface-2"
            >
              <span className="text-faint">✦</span>
              Settings
            </Link>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                logout();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg"
            >
              <span className="text-faint">⏻</span>
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/** Projects → Boards tree with inline create controls. */
function ProjectsNav() {
  const pathname = usePathname();
  const { projects } = useWorkspace();
  const [creating, setCreating] = useState(false);
  return (
    <div className="mt-4 px-3">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
          Projects
        </span>
        <button
          onClick={() => setCreating(true)}
          title="New project"
          className="text-faint transition-colors hover:text-accent"
        >
          +
        </button>
      </div>
      {creating ? (
        <ProjectModal mode="create" onClose={() => setCreating(false)} />
      ) : null}
      <div className="max-h-[42vh] space-y-0.5 overflow-y-auto">
        {projects.length === 0 ? (
          <p className="px-2 py-1 text-xs text-faint">No projects yet.</p>
        ) : (
          projects.map((p) => (
            <ProjectRow key={p.id} project={p} pathname={pathname} />
          ))
        )}
      </div>
    </div>
  );
}

function ProjectRow({ project, pathname }: { project: Project; pathname: string }) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const boards = project.boards ?? [];
  const projectActive = pathname === `/projects/${project.id}`;

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-lg pr-1 hover:bg-surface-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="py-1.5 pl-1 pr-0.5 text-faint hover:text-fg"
          aria-label={open ? "Collapse project" : "Expand project"}
        >
          {open ? "▾" : "▸"}
        </button>
        <Avatar name={project.name} size={16} imageUrl={project.image} color={project.color} />
        <Link
          href={`/projects/${project.id}`}
          className={[
            "flex-1 truncate py-1.5 text-sm",
            projectActive ? "font-medium text-accent" : "text-muted hover:text-fg",
          ].join(" ")}
        >
          {project.name}
        </Link>
        <button
          onClick={() => setEditing(true)}
          title="Project settings"
          className="px-1 text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        >
          ⚙
        </button>
        <button
          onClick={() => {
            setOpen(true);
            setAdding(true);
          }}
          title="New board"
          className="px-1 text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        >
          +
        </button>
      </div>

      {editing ? (
        <ProjectModal
          mode="edit"
          project={project}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {open ? (
        <div className="ml-4 border-l border-border pl-2">
          {boards.map((b) => {
            const active = pathname === `/boards/${b.id}`;
            return (
              <Link
                key={b.id}
                href={`/boards/${b.id}`}
                className={[
                  "flex items-center gap-2 truncate rounded-md px-2 py-1 text-[13px]",
                  active
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-muted hover:bg-surface-2 hover:text-fg",
                ].join(" ")}
              >
                <Avatar name={b.name} size={16} imageUrl={b.image} color={b.color} />
                <span className="truncate">{b.name}</span>
              </Link>
            );
          })}
        </div>
      ) : null}

      {adding ? (
        <BoardModal
          mode="create"
          projectId={project.id}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

