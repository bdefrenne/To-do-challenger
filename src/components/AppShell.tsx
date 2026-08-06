"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { WorkspaceProvider, useWorkspace } from "./workspace/WorkspaceContext";
import { TaskDetailModal } from "./workspace/TaskDetailModal";
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
  { href: "/canvas", label: "Canvas", icon: "◳" },
  { href: "/notes", label: "Notes", icon: "✎" },
  { href: "/calendar", label: "Calendar", icon: "▦" },
  { href: "/archived", label: "Archived", icon: "🗄" },
];

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: SessionUser;
}) {
  return (
    <PeopleProvider me={user}>
      <WorkspaceProvider meName={user.name} meId={user.id}>
        <div className="flex min-h-screen">
          <Sidebar user={user} />
          <main className="flex-1 overflow-x-hidden">{children}</main>
        </div>
        <TaskDetailModal />
        <GlobalProjectSettings />
        <Notice />
        <DeleteUndoToast />
        <SendUndoToast />
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
 *  window. Clears itself when the window lapses (delete commits) or on Undo. */
function DeleteUndoToast() {
  const { pendingDeletes, undoDelete } = useWorkspace();
  if (!pendingDeletes.length) return null;
  const last = pendingDeletes[pendingDeletes.length - 1];
  // Done tasks are archived, not deleted — the verb follows the latest action.
  const verb = last.mode === "archive" ? "Archived" : "Deleted";
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

function Sidebar({ user }: { user: SessionUser }) {
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
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">
            To-do Challenger
          </div>
          <div className="text-[11px] text-faint">Personal workspace</div>
        </div>
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

